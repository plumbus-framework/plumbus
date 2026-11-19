// Lazily opened capability transactions, against a real Postgres whose pool holds ONE
// connection, so "the handler holds a connection" is directly observable: anything else on
// the pool waits behind it. Before this change an action's transaction began before its
// handler ran and held the connection for the whole handler, writes or not.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
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
  )
`;

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

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** One database whose pool has exactly one connection. */
async function fixture(capabilities: CapabilityContract[], config: Record<string, unknown> = {}) {
  const entities = noteRegistry();
  const handle = await createDurableTestDatabase({
    kind: 'lazy_tx',
    ddl: `${AUDIT_DDL}; ${entityDdl(entities)}`,
  });
  closers.push(() => handle.close());
  const registry = new CapabilityRegistry();
  registry.registerAll(capabilities);
  const db: PostgresJsDatabase = handle.db;
  return {
    db,
    run(cap: CapabilityContract, input: unknown) {
      const deps = wireContextDependencies(
        { db, auth, entities, events: new EventRegistry() },
        { config, ...buildCapabilityRuntimeDeps(registry) },
      );
      return executeCapability(cap, createExecutionContext(deps), input);
    },
    async titles(): Promise<string[]> {
      const rows = await db.execute(sql`SELECT title FROM note ORDER BY title`);
      return (rows as unknown as Array<{ title: string }>).map((row) => row.title);
    },
    async auditActions(): Promise<string[]> {
      const rows = await db.execute(sql`SELECT action FROM audit_records ORDER BY action`);
      return (rows as unknown as Array<{ action: string }>).map((row) => row.action);
    },
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

describe('lazily opened capability transactions on a one-connection pool', () => {
  it('a handler that only reads holds no connection while it works', async () => {
    const entered = gate();
    const release = gate();
    const reader = action('reader', async (ctx) => {
      await ctx.data.Note?.findMany({});
      entered.open();
      await release.wait;
      return { ok: true };
    });
    const env = await fixture([reader]);
    const running = env.run(reader, { title: 'x' });
    await entered.wait;
    // Before: BEGIN had taken the only connection, so this waited for the handler to finish.
    await expect(within(3000, env.db.execute(sql`SELECT 1 AS one`))).resolves.toBeDefined();
    release.open();
    await expect(running).resolves.toMatchObject({ success: true });
  }, 60_000);

  it("execution.transactionBegin: 'eager' holds the connection for the whole handler, as before", async () => {
    const entered = gate();
    const release = gate();
    const reader = action('readerEager', async (ctx) => {
      await ctx.data.Note?.findMany({});
      entered.open();
      await release.wait;
      return { ok: true };
    });
    const env = await fixture([reader], { execution: { transactionBegin: 'eager' } });
    const running = env.run(reader, { title: 'x' });
    await entered.wait;
    const other = env.db.execute(sql`SELECT 1 AS one`);
    await expect(within(1500, other)).rejects.toThrow('did not settle');
    release.open();
    await expect(running).resolves.toMatchObject({ success: true });
    await other;
  }, 60_000);

  it('commits every write, and an audit record made before the first one, together', async () => {
    const writer = action('writer', async (ctx) => {
      await ctx.data.Note?.findMany({});
      await ctx.audit.record('note.before-write', { outcome: 'success' });
      await ctx.data.Note?.create({ title: 'a' });
      // From the first write on, reads run in the transaction and see its writes.
      const seen = await ctx.data.Note?.findMany({});
      if (seen?.length !== 1) throw new Error('the transaction did not see its own write');
      await ctx.data.Note?.create({ title: 'b' });
      return { ok: true };
    });
    const env = await fixture([writer]);
    await expect(within(10_000, env.run(writer, { title: 'x' }))).resolves.toMatchObject({
      success: true,
    });
    expect(await env.titles()).toEqual(['a', 'b']);
    expect(await env.auditActions()).toEqual(
      expect.arrayContaining(['capability.notes.writer', 'note.before-write']),
    );
  }, 60_000);

  it('rolls back every write when the handler throws; success records go, the failure stays', async () => {
    const failing = action('failing', async (ctx) => {
      await ctx.audit.record('note.before-write', { outcome: 'success' });
      await ctx.data.Note?.create({ title: 'a' });
      await ctx.data.Note?.create({ title: 'b' });
      throw new Error('business rule failed after the writes');
    });
    const env = await fixture([failing]);
    await expect(within(10_000, env.run(failing, { title: 'x' }))).resolves.toMatchObject({
      success: false,
    });
    expect(await env.titles()).toEqual([]);
    const actions = await env.auditActions();
    expect(actions).not.toContain('note.before-write');
    expect(actions).toContain('capability.notes.failing');
  }, 60_000);

  it('writes a success record of a handler that never opened the transaction after it returns', async () => {
    const recordOnly = action('recordOnly', async (ctx) => {
      await ctx.audit.record('note.read-only', { outcome: 'success' });
      return { ok: true };
    });
    const env = await fixture([recordOnly]);
    await expect(within(10_000, env.run(recordOnly, { title: 'x' }))).resolves.toMatchObject({
      success: true,
    });
    expect(await env.auditActions()).toContain('note.read-only');
  }, 60_000);

  it('a nested capability shares the parent transaction: the parent failing rolls back its write', async () => {
    const child = action('child', async (ctx) => {
      await ctx.data.Note?.create({ title: 'child' });
      return { ok: true };
    });
    const parent = action(
      'parent',
      async (ctx) => {
        await ctx.data.Note?.findMany({});
        await ctx.capabilities.invoke('notes.child' as never, { title: 'x' });
        throw new Error('parent fails after the child wrote');
      },
      {
        effects: {
          data: ['Note'],
          events: [],
          external: [],
          ai: false,
          capabilities: ['notes.child'],
        },
      },
    );
    const env = await fixture([parent, child]);
    await expect(within(10_000, env.run(parent, { title: 'x' }))).resolves.toMatchObject({
      success: false,
    });
    expect(await env.titles()).toEqual([]);
  }, 60_000);

  it('refuses with a typed 503 instead of queueing when no connection frees within the wait', async () => {
    const writer = action('writerUnderPressure', async (ctx) => {
      await ctx.data.Note?.create({ title: 'never' });
      return { ok: true };
    });
    const env = await fixture([writer], { execution: { transactionAcquireTimeoutMs: 300 } });
    // Another transaction holds the pool's only connection.
    const held = gate();
    const holding = env.db.transaction(async () => {
      await held.wait;
    });
    // Settles while the connection is still held: neither BEGIN nor the failure audit record
    // (written once a connection frees) makes the refusal wait.
    const result = await within(5000, env.run(writer, { title: 'x' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.metadata).toMatchObject({
      reason: 'pool-acquire-timeout',
      httpStatus: 503,
      timeoutMs: 300,
    });
    held.open();
    await holding;
    // The abandoned BEGIN got its connection, rolled back and gave it back: the pool works,
    // nothing was written, and the refusal's audit record landed.
    await expect(within(3000, env.titles())).resolves.toEqual([]);
    for (let i = 0; i < 50 && !(await env.auditActions()).length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await env.auditActions()).toContain('capability.notes.writerUnderPressure');
  }, 60_000);
});
