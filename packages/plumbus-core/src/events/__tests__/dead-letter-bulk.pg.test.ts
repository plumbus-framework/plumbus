// Settling event dead letters in bulk, and on tenant planes from the CLI, against real
// PostgreSQL: `resolveEventDeadLetters` and `plumbus events dead-letter resolve-all`.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAllDeadLetters, withDeadLetterTargets } from '../../cli/commands/events-ops.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import { resolveEventDeadLetter, resolveEventDeadLetters } from '../dead-letter-resolution.js';

const harnesses: DurableTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(): Promise<DurableTestHarness> {
  const h = await createDurableTestHarness({ includeEventDelivery: true });
  harnesses.push(h);
  return h;
}

async function seed(
  db: PostgresJsDatabase,
  count: number,
  eventType: string,
  consumerId: string,
  failedAt: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO event_dead_letter (event_id, event_type, payload, consumer_id, retry_count, failed_at)
    SELECT gen_random_uuid()::text, ${eventType}, '{}'::jsonb, ${consumerId}, '3',
           ${failedAt}::timestamptz + (g || ' seconds')::interval
    FROM generate_series(1, ${count}) g
  `);
}

async function unresolved(db: PostgresJsDatabase): Promise<Record<string, number>> {
  const rows = (await db.execute(sql`
    SELECT event_type, count(*)::int AS n FROM event_dead_letter
    WHERE (metadata->>'resolvedAt') IS NULL GROUP BY event_type ORDER BY event_type
  `)) as unknown as Array<{ event_type: string; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.event_type, row.n]));
}

const actor = { actor: 'operator-1', note: 'owned by another relay' };

describe('resolveEventDeadLetters', () => {
  it('marks only matching unresolved rows, oldest first, at most the limit', async () => {
    const h = await harness();
    await seed(h.tenantDb, 5, 'invoice.issued', 'mailer', '2026-01-01T00:00:00Z');
    await seed(h.tenantDb, 3, 'invoice.paid', 'ledger', '2026-01-01T00:00:00Z');
    await seed(h.tenantDb, 2, 'invoice.issued', 'mailer', '2026-06-01T00:00:00Z');

    expect(
      await resolveEventDeadLetters(
        h.tenantDb,
        { eventType: 'invoice.issued', failedBefore: new Date('2026-03-01T00:00:00Z'), limit: 3 },
        actor,
      ),
    ).toBe(3);
    // The oldest three of that type went first.
    const marked = (await h.tenantDb.execute(sql`
      SELECT failed_at FROM event_dead_letter WHERE (metadata->>'resolvedAt') IS NOT NULL ORDER BY failed_at
    `)) as unknown as Array<{ failed_at: Date }>;
    expect(marked.map((row) => new Date(row.failed_at).toISOString())).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
    ]);
    expect(
      await resolveEventDeadLetters(
        h.tenantDb,
        { eventType: 'invoice.issued', failedBefore: new Date('2026-03-01T00:00:00Z') },
        actor,
      ),
    ).toBe(2);
    expect(await unresolved(h.tenantDb)).toEqual({ 'invoice.issued': 2, 'invoice.paid': 3 });
    expect(await resolveEventDeadLetters(h.tenantDb, { consumerId: 'ledger' }, actor)).toBe(3);
    expect(await unresolved(h.tenantDb)).toEqual({ 'invoice.issued': 2 });
  });

  it('keeps the first resolution of a row resolved before', async () => {
    const h = await harness();
    await seed(h.tenantDb, 1, 'invoice.issued', 'mailer', '2026-01-01T00:00:00Z');
    const [row] = (await h.tenantDb.execute(
      sql`SELECT id::text FROM event_dead_letter`,
    )) as unknown as Array<{ id: string }>;
    await resolveEventDeadLetter(h.tenantDb, row?.id ?? '', {
      actor: 'first',
      resolution: 'retried',
    });
    expect(await resolveEventDeadLetters(h.tenantDb, {}, actor)).toBe(0);
    const [after] = (await h.tenantDb.execute(
      sql`SELECT metadata FROM event_dead_letter`,
    )) as unknown as Array<{ metadata: Record<string, unknown> }>;
    expect(after?.metadata).toMatchObject({ resolvedBy: 'first', resolution: 'retried' });
  });

  it('validates its filter and options', async () => {
    const h = await harness();
    await expect(resolveEventDeadLetters(h.tenantDb, { limit: 0 }, actor)).rejects.toThrow(
      /Invalid event dead-letter filter/,
    );
    await expect(
      resolveEventDeadLetters(h.tenantDb, { unknown: 1 } as never, actor),
    ).rejects.toThrow(/Invalid event dead-letter filter/);
    await expect(resolveEventDeadLetters(h.tenantDb, {}, { actor: '' })).rejects.toThrow(
      /Invalid event dead-letter resolution/,
    );
  });
});

describe('plumbus events dead-letter on tenant planes', () => {
  function extensionsFor(h: DurableTestHarness, refs: string[]) {
    let closed = 0;
    const resolver = Object.assign(createSingleDataPlaneResolver(h.tenantDb), {
      close: async () => {
        closed += 1;
      },
    });
    return {
      load: async () => ({ dataPlaneResolver: resolver, listTenantRefs: () => refs }) as never,
      closed: () => closed,
    };
  }

  it('settles a pile larger than one batch on every listed plane, through the resolver', async () => {
    const h = await harness();
    await seed(h.tenantDb, 2_500, 'invoice.issued', 'mailer', '2026-01-01T00:00:00Z');
    await seed(h.tenantDb, 4, 'invoice.paid', 'ledger', '2026-01-01T00:00:00Z');
    const ext = extensionsFor(h, ['tenant-a']);
    const result = await resolveAllDeadLetters(
      { allTenants: true, eventType: 'invoice.issued', note: 'owned by another relay' },
      (opts, fn) => withDeadLetterTargets(opts, fn, ext.load),
    );
    expect(result).toEqual([{ label: 'tenant-plane:tenant-a', result: 2_500 }]);
    expect(await unresolved(h.tenantDb)).toEqual({ 'invoice.paid': 4 });
    // The pool database was not touched: the spine has no dead-letter table at all.
    expect(ext.closed()).toBe(1);
  });

  it('lists rows of one plane', async () => {
    const h = await harness();
    await seed(h.tenantDb, 2, 'invoice.issued', 'mailer', '2026-01-01T00:00:00Z');
    const ext = extensionsFor(h, []);
    const [listed] = await withDeadLetterTargets(
      { tenant: 'tenant-a' },
      async (db) =>
        (await db.execute(sql`SELECT event_type FROM event_dead_letter`)) as unknown as unknown[],
      ext.load,
    );
    expect(listed?.label).toBe('tenant-plane:tenant-a');
    expect(listed?.result).toHaveLength(2);
  });

  it('refuses a call without a filter unless it says --every, and conflicting targets', async () => {
    const h = await harness();
    await seed(h.tenantDb, 3, 'invoice.issued', 'mailer', '2026-01-01T00:00:00Z');
    const ext = extensionsFor(h, ['tenant-a']);
    const targets: typeof withDeadLetterTargets = (opts, fn) =>
      withDeadLetterTargets(opts, fn, ext.load);
    await expect(resolveAllDeadLetters({ allTenants: true }, targets)).rejects.toThrow(/--every/);
    await expect(
      resolveAllDeadLetters({ allTenants: true, before: 'yesterday-ish' }, targets),
    ).rejects.toThrow(/not a date/);
    await expect(
      resolveAllDeadLetters({ allTenants: true, tenant: 'tenant-a', every: true }, targets),
    ).rejects.toThrow(/either --tenant/);
    expect(await resolveAllDeadLetters({ tenant: 'tenant-a', every: true }, targets)).toEqual([
      { label: 'tenant-plane:tenant-a', result: 3 },
    ]);
  });

  it('says what is missing when app/server.ts cannot reach tenant planes', async () => {
    await expect(
      withDeadLetterTargets(
        { tenant: 't' },
        async () => 0,
        async () => ({}) as never,
      ),
    ).rejects.toThrow(/no dataPlaneResolver/);
    const resolver = createSingleDataPlaneResolver({} as never);
    await expect(
      withDeadLetterTargets(
        { allTenants: true },
        async () => 0,
        async () => ({ dataPlaneResolver: resolver }) as never,
      ),
    ).rejects.toThrow(/no listTenantRefs/);
  });
});
