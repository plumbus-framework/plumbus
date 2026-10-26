// Audit inside a transactional capability, against a real Postgres whose pool holds ONE
// connection. Before audit was bound to the transaction, every repository mutation and every
// `ctx.audit.record` inside the transaction asked the pool for a second connection while the
// transaction held the only one — the call never finished. These tests prove the call
// completes on one connection, that failure/denied records survive a rollback while success
// records roll back with the work, and that post-commit audits land after the transaction.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAuditService, createDatabaseAuditWriter } from '../../audit/index.js';
import { EntityRegistry } from '../../data/registry.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { EventRegistry } from '../../events/registry.js';
import { field } from '../../fields/index.js';
import type { AuditService } from '../../types/audit.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { AuthContext } from '../../types/security.js';
import { CapabilityRegistry } from '../capability-registry.js';
import { executeCapability } from '../capability-executor.js';
import { buildCapabilityRuntimeDeps } from '../capability-invocation.js';
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

function noteTableConfig(registry: EntityRegistry) {
  const table = registry.getTable('Note');
  if (!table) throw new Error('Note table was not generated');
  return getTableConfig(table);
}

function entityTable(registry: EntityRegistry): string {
  return noteTableConfig(registry).name;
}

/** CREATE TABLE for the generated entity table (defaults for id and timestamps). */
function entityDdl(registry: EntityRegistry): string {
  const config = noteTableConfig(registry);
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
  capabilities: string[] = [],
): CapabilityContract {
  return {
    name,
    kind: 'action',
    domain: 'notes',
    input: z.object({ title: z.string() }),
    output: z.object({ ok: z.boolean() }),
    effects: { data: ['Note'], events: [], external: [], ai: false, capabilities },
    access: { roles: ['admin'] },
    handler,
  } as CapabilityContract;
}

interface Fixture {
  db: PostgresJsDatabase;
  run(cap: CapabilityContract, input: unknown): ReturnType<typeof executeCapability>;
  auditActions(): Promise<Array<{ id: string; action: string; outcome: string }>>;
  noteTitles(): Promise<string[]>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** One database whose pool has exactly one connection (`max: 1`). */
async function fixture(options: {
  capabilities: CapabilityContract[];
  audit?: (db: PostgresJsDatabase) => AuditService;
}): Promise<Fixture> {
  const entities = noteRegistry();
  const handle = await createDurableTestDatabase({
    kind: 'tx_audit',
    ddl: `${AUDIT_DDL}; ${entityDdl(entities)}`,
  });
  closers.push(() => handle.close());
  const registry = new CapabilityRegistry();
  registry.registerAll(options.capabilities);
  const db = handle.db;
  const notesTable = entityTable(entities);
  return {
    db,
    run(cap, input) {
      const deps = wireContextDependencies(
        {
          db,
          auth,
          entities,
          events: new EventRegistry(),
          ...(options.audit ? { audit: options.audit(db) } : {}),
        },
        { config: {}, ...buildCapabilityRuntimeDeps(registry) },
      );
      return executeCapability(cap, createExecutionContext(deps), input);
    },
    async auditActions() {
      const rows = await db.execute(
        sql`SELECT id::text AS id, action, outcome FROM audit_records ORDER BY "timestamp", action`,
      );
      return rows as unknown as Array<{ id: string; action: string; outcome: string }>;
    },
    async noteTitles() {
      const rows = await db.execute(
        sql`SELECT title FROM ${sql.identifier(notesTable)} ORDER BY title`,
      );
      return (rows as unknown as Array<{ title: string }>).map((row) => row.title);
    },
  };
}

/** Fails instead of hanging: the deadlock this suite guards against never settles. */
async function withinSeconds<T>(seconds: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`did not settle within ${seconds}s`)),
      seconds * 1000,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('audit inside a transactional capability on a one-connection pool', () => {
  it('mutates an entity and records audit without a second connection', async () => {
    const write = action('write', async (ctx, input) => {
      await ctx.data.Note.create({ title: (input as { title: string }).title });
      await ctx.audit.record('note.custom', { outcome: 'success' });
      return { ok: true };
    });
    const env = await fixture({ capabilities: [write] });

    // Concurrent calls queue for the one connection; none waits on itself.
    const results = await withinSeconds(
      10,
      Promise.all(['a', 'b', 'c'].map((title) => env.run(write, { title }))),
    );

    expect(results.every((result) => result.success)).toBe(true);
    expect(await env.noteTitles()).toEqual(['a', 'b', 'c']);
    const actions = (await env.auditActions()).map((row) => row.action);
    expect(actions.filter((name) => name === 'Note.create')).toHaveLength(3);
    expect(actions.filter((name) => name === 'note.custom')).toHaveLength(3);
    expect(actions.filter((name) => name === 'capability.notes.write')).toHaveLength(3);
  }, 60_000);

  it('keeps failure and denied records of a rolled-back transaction and drops success ones', async () => {
    const failing = action('failing', async (ctx, input) => {
      await ctx.data.Note.create({ title: (input as { title: string }).title });
      await ctx.audit.record('note.refused', { outcome: 'denied' });
      await ctx.audit.record('note.broken', { outcome: 'failure' });
      await ctx.audit.record('note.done', { outcome: 'success' });
      throw ctx.errors.conflict('cannot finish');
    });
    const env = await fixture({ capabilities: [failing] });

    const result = await withinSeconds(10, env.run(failing, { title: 'lost' }));

    expect(result.success).toBe(false);
    expect(await env.noteTitles()).toEqual([]);
    const rows = await env.auditActions();
    const actions = rows.map((row) => row.action);
    expect(actions.filter((name) => name === 'note.refused')).toHaveLength(1);
    expect(actions.filter((name) => name === 'note.broken')).toHaveLength(1);
    expect(actions).not.toContain('note.done');
    expect(actions).not.toContain('Note.create');
    expect(rows.find((row) => row.action === 'capability.notes.failing')?.outcome).toBe('failure');
  }, 60_000);

  it('writes a nested capability success audit after the parent commits', async () => {
    const child = action('child', async (ctx, input) => {
      await ctx.data.Note.create({ title: `child-${(input as { title: string }).title}` });
      return { ok: true };
    });
    const parent = action(
      'parent',
      async (ctx, input) => {
        await ctx.capabilities.invoke('notes.child', input);
        return { ok: true };
      },
      ['notes.child'],
    );
    const env = await fixture({ capabilities: [parent, child] });

    const result = await withinSeconds(10, env.run(parent, { title: 'x' }));

    expect(result.success).toBe(true);
    expect(await env.noteTitles()).toEqual(['child-x']);
    const actions = (await env.auditActions()).map((row) => row.action);
    expect(actions).toContain('capability.notes.child');
    expect(actions).toContain('capability.notes.parent');
  }, 60_000);

  it('keeps a custom audit writer on the outer pool (and so on a second connection)', async () => {
    const write = action('write', async (ctx) => {
      await ctx.audit.record('note.custom', { outcome: 'success' });
      return { ok: true };
    });
    const env = await fixture({
      capabilities: [write],
      audit: (db) => createAuditService({ db, auth, writer: createDatabaseAuditWriter(db) }),
    });

    // The app's own writer is not re-routed: on a one-connection pool it waits behind the
    // transaction that holds the connection — the behaviour the default service no longer has.
    await expect(withinSeconds(2, env.run(write, { title: 'x' }))).rejects.toThrow(
      'did not settle',
    );
  }, 60_000);
});
