// Success audit rows against a real Postgres whose pool holds ONE connection.
//
// Before this change an action's `capability.<name>` success row was inserted after its
// transaction committed, on a second checkout of the pool, and a failed insert turned the
// committed action into "Audit persistence failed". Now:
// - with a framework transaction the row is written in it (same transaction id as the data),
//   so a failed insert rolls the work back instead of failing a committed call;
// - without one (`transactional: false`, AI/external effects) a failed insert does not fail
//   the call: the row is retried in the background with the same id and reported;
// - `audit.deferSuccess` holds every success row of such a capability until its handler ends,
//   so a handler holding its own transaction never waits for an audit insert;
// - `audit.success: false` drops only the success row.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AuditWriteFailure, createAuditService } from '../../audit/index.js';
import { EntityRegistry } from '../../data/registry.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { EventRegistry } from '../../events/registry.js';
import { field } from '../../fields/index.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { AuthContext } from '../../types/security.js';
import { executeCapability } from '../capability-executor.js';
import { buildCapabilityRuntimeDeps } from '../capability-invocation.js';
import { CapabilityRegistry } from '../capability-registry.js';
import { createExecutionContext } from '../context-factory.js';
import { wireContextDependencies } from '../context-deps.js';

const AUDIT_DDL = `
  CREATE TABLE audit_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor text NOT NULL,
    tenant_id text,
    "timestamp" timestamptz NOT NULL DEFAULT now(),
    component text NOT NULL,
    action text NOT NULL,
    outcome text NOT NULL,
    metadata jsonb,
    masked_fields jsonb
  );
  CREATE TABLE refuse_success (on_off boolean NOT NULL);
  INSERT INTO refuse_success VALUES (false)
`;

/** Refuses `capability.*` success rows while `refuse_success.on_off` is true (one statement each). */
const REFUSAL_TRIGGER = [
  `CREATE FUNCTION refuse_capability_success() RETURNS trigger AS $$
  BEGIN
    IF NEW.outcome = 'success' AND NEW.action LIKE 'capability.%'
       AND (SELECT on_off FROM refuse_success) THEN
      RAISE EXCEPTION 'audit store refuses this row';
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER refuse_capability_success BEFORE INSERT ON audit_records
    FOR EACH ROW EXECUTE FUNCTION refuse_capability_success()`,
];

const auth: AuthContext = {
  userId: 'user-1',
  roles: ['admin'],
  scopes: [],
  provider: 'test',
  tenantId: 'tenant-1',
};

function noteRegistry(): EntityRegistry {
  const registry = new EntityRegistry();
  registry.register({
    name: 'Note',
    fields: { id: field.id(), title: field.string({ required: true }) },
  } as never);
  return registry;
}

function entityDdl(registry: EntityRegistry): string {
  const table = registry.getTable('Note');
  if (!table) throw new Error('Note table was not generated');
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const type = column.getSQLType();
    const fallback = column.hasDefault
      ? type === 'uuid'
        ? ' DEFAULT gen_random_uuid()'
        : type.startsWith('timestamp')
          ? ' DEFAULT now()'
          : ''
      : '';
    return `"${column.name}" ${type}${column.primary ? ' PRIMARY KEY' : ''}${
      column.notNull && !column.primary ? ' NOT NULL' : ''
    }${fallback}`;
  });
  return `CREATE TABLE "${config.name}" (${columns.join(', ')})`;
}

function action(
  name: string,
  handler: CapabilityContract['handler'],
  extra: Partial<CapabilityContract> = {},
): CapabilityContract {
  return {
    name,
    kind: 'action',
    domain: 'notes',
    input: z.object({ title: z.string() }),
    output: z.object({ ok: z.boolean() }),
    effects: { data: ['Note'], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    handler,
    ...extra,
  } as CapabilityContract;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function fixture(capabilities: CapabilityContract[]) {
  const entities = noteRegistry();
  const handle = await createDurableTestDatabase({
    kind: 'success_audit',
    ddl: `${AUDIT_DDL}; ${entityDdl(entities)}`,
  });
  closers.push(() => handle.close());
  for (const statement of REFUSAL_TRIGGER) await handle.db.execute(sql.raw(statement));
  const registry = new CapabilityRegistry();
  registry.registerAll(capabilities);
  const db: PostgresJsDatabase = handle.db;
  const failures: AuditWriteFailure[] = [];
  const rows = async <T>(query: ReturnType<typeof sql>) => [
    ...((await db.execute(query)) as unknown as T[]),
  ];
  return {
    db,
    failures,
    run(cap: CapabilityContract, input: unknown) {
      const audit = createAuditService({
        db,
        auth,
        retryDelaysMs: [100, 100, 100],
        onWriteFailure: (failure) => failures.push(failure),
      });
      const deps = wireContextDependencies(
        { db, auth, entities, events: new EventRegistry(), audit },
        { config: {}, ...buildCapabilityRuntimeDeps(registry) },
      );
      return executeCapability(cap, createExecutionContext(deps), input);
    },
    refuseSuccessRows: (on: boolean) => db.execute(sql`UPDATE refuse_success SET on_off = ${on}`),
    titles: async () =>
      (await rows<{ title: string }>(sql`SELECT title FROM note ORDER BY title`)).map(
        (r) => r.title,
      ),
    audit: () =>
      rows<{ id: string; action: string; outcome: string; xid: string }>(
        sql`SELECT id::text, action, outcome, xmin::text AS xid FROM audit_records ORDER BY "timestamp", action`,
      ),
    noteXid: async () =>
      (await rows<{ xid: string }>(sql`SELECT xmin::text AS xid FROM note LIMIT 1`))[0]?.xid,
  };
}

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('success audit rows of a capability with a framework transaction', () => {
  it('is written in the transaction of the data it records (same transaction id)', async () => {
    const writer = action('writer', async (ctx, input: { title: string }) => {
      await ctx.data.Note?.create({ title: input.title });
      return { ok: true };
    });
    const env = await fixture([writer]);
    await expect(env.run(writer, { title: 'a' })).resolves.toMatchObject({ success: true });
    const rows = await env.audit();
    const success = rows.find((row) => row.action === 'capability.notes.writer');
    expect(success?.outcome).toBe('success');
    expect(success?.xid).toBe(await env.noteXid());
    expect(rows.find((row) => row.action === 'Note.create')?.xid).toBe(await env.noteXid());
  }, 60_000);

  it('a success row that cannot be written rolls the work back: the call fails, nothing committed', async () => {
    const writer = action('writer', async (ctx, input: { title: string }) => {
      await ctx.data.Note?.create({ title: input.title });
      return { ok: true };
    });
    const env = await fixture([writer]);
    await env.refuseSuccessRows(true);
    // Before: the note committed and the call then threw "Audit persistence failed".
    const result = await env.run(writer, { title: 'a' });
    expect(result.success).toBe(false);
    expect(await env.titles()).toEqual([]);
    expect((await env.audit()).map((row) => [row.action, row.outcome])).toEqual([
      ['capability.notes.writer', 'failure'],
    ]);
  }, 60_000);
});

describe('success audit rows of a capability without a framework transaction', () => {
  it('a row that cannot be written does not fail the committed call; it is retried with its id', async () => {
    const writer = action(
      'plainWriter',
      async (ctx, input: { title: string }) => {
        await ctx.data.Note?.create({ title: input.title });
        return { ok: true };
      },
      { transactional: false },
    );
    const env = await fixture([writer]);
    await env.refuseSuccessRows(true);
    // Before: this threw "Audit persistence failed" although the note was written.
    await expect(env.run(writer, { title: 'a' })).resolves.toMatchObject({ success: true });
    expect(await env.titles()).toEqual(['a']);
    expect(env.failures.map((f) => f.final)).toEqual([false]);
    const reportedId = env.failures[0]?.events[0]?.id;
    expect(env.failures[0]?.events[0]?.action).toBe('capability.notes.plainWriter');

    await env.refuseSuccessRows(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const success = (await env.audit()).filter(
      (row) => row.action === 'capability.notes.plainWriter',
    );
    expect(success.map((row) => row.id)).toEqual([reportedId]);
  }, 60_000);

  it('a row the store keeps refusing is reported lost, with the record, after the last retry', async () => {
    const writer = action('lost', async () => ({ ok: true }), { transactional: false });
    const env = await fixture([writer]);
    await env.refuseSuccessRows(true);
    await expect(env.run(writer, { title: 'a' })).resolves.toMatchObject({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(env.failures.map((f) => [f.final, f.attempts])).toEqual([
      [false, 1],
      [false, 2],
      [false, 3],
      [true, 4],
    ]);
    expect(env.failures.at(-1)?.events[0]).toMatchObject({
      action: 'capability.notes.lost',
      outcome: 'success',
    });
  }, 60_000);

  it('audit.deferSuccess: a handler holding its own transaction never waits for an audit insert', async () => {
    let auditRowsDuringHandler = -1;
    const holder = action(
      'holder',
      async (ctx, input: { title: string }) => {
        // The handler's own transaction takes the pool's only connection. An audit insert
        // made now (ctx.audit or a repository write) would wait for a second one forever.
        await (ctx as unknown as { __db: PostgresJsDatabase }).__db.transaction(async (tx) => {
          await tx.execute(sql`INSERT INTO note (title) VALUES (${input.title})`);
          await ctx.audit.record('notes.custom', { outcome: 'success' });
        });
        await ctx.data.Note?.create({ title: `${input.title}-2` });
        const [row] = (await (ctx as unknown as { __db: PostgresJsDatabase }).__db.execute(
          sql`SELECT count(*)::int AS n FROM audit_records`,
        )) as unknown as Array<{ n: number }>;
        auditRowsDuringHandler = Number(row?.n);
        return { ok: true };
      },
      { transactional: false, audit: { event: 'capability.notes.holder', deferSuccess: true } },
    );
    const env = await fixture([holder]);
    const withDb = {
      ...holder,
      handler: (ctx: any, input: any) => holder.handler({ ...ctx, __db: env.db }, input),
    };
    await expect(
      within(5_000, env.run(withDb as CapabilityContract, { title: 'x' })),
    ).resolves.toMatchObject({
      success: true,
    });
    expect(auditRowsDuringHandler).toBe(0);
    const rows = await env.audit();
    expect(rows.map((row) => row.action).sort()).toEqual([
      'Note.create',
      'capability.notes.holder',
      'notes.custom',
    ]);
    // Written together, in one statement, when the handler ended.
    expect(new Set(rows.map((row) => row.xid)).size).toBe(1);
  }, 60_000);

  it('audit.deferSuccess: held rows are still written when the handler fails, and the refusal row at once', async () => {
    const failing = action(
      'failing',
      async (ctx, input: { title: string }) => {
        await ctx.data.Note?.create({ title: input.title });
        throw new Error('after the write');
      },
      { transactional: false, audit: { event: 'capability.notes.failing', deferSuccess: true } },
    );
    const env = await fixture([failing]);
    await expect(env.run(failing, { title: 'kept' })).resolves.toMatchObject({ success: false });
    expect(await env.titles()).toEqual(['kept']);
    expect((await env.audit()).map((row) => [row.action, row.outcome]).sort()).toEqual([
      ['Note.create', 'success'],
      ['capability.notes.failing', 'failure'],
    ]);
  }, 60_000);
});

describe('audit.success: false', () => {
  it('drops only the success row; failures are recorded and the data rows stay', async () => {
    const quiet = action(
      'quiet',
      async (ctx, input: { title: string }) => {
        await ctx.data.Note?.create({ title: input.title });
        if (input.title === 'boom') throw new Error('boom');
        return { ok: true };
      },
      { audit: { event: 'capability.notes.quiet', success: false } },
    );
    const env = await fixture([quiet]);
    await expect(env.run(quiet, { title: 'a' })).resolves.toMatchObject({ success: true });
    await expect(env.run(quiet, { title: 'boom' })).resolves.toMatchObject({ success: false });
    expect((await env.audit()).map((row) => [row.action, row.outcome]).sort()).toEqual([
      ['Note.create', 'success'],
      ['capability.notes.quiet', 'failure'],
    ]);
  }, 60_000);
});
