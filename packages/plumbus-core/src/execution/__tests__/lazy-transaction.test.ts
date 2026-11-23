import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAuditService } from '../../audit/index.js';
import { DataPoolAcquireTimeoutError } from '../../errors/index.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { FlowService, TransactionScope } from '../../types/context.js';
import { executeCapability } from '../capability-executor.js';
import { createExecutionContext } from '../context-factory.js';
import { createDeferredTransaction } from '../deferred-transaction.js';
import { createDeferredFlowService } from '../deferred-flow-service.js';
import { createTransactionRunner, resolveTransactionRunOptions } from '../transactional-outbox.js';

/**
 * A `db.transaction` that behaves like postgres.js: it waits for a free connection (`free`),
 * runs BEGIN, the callback, then COMMIT — or ROLLBACK and rethrow when the callback throws.
 */
function fakeDb(options: { free?: Promise<void> } = {}) {
  const log: string[] = [];
  const tx = { label: 'tx' };
  const db = {
    label: 'pool',
    transaction: vi.fn(async (cb: (handle: unknown) => Promise<unknown>) => {
      await options.free;
      log.push('BEGIN');
      try {
        const result = await cb(tx);
        log.push('COMMIT');
        return result;
      } catch (error) {
        log.push('ROLLBACK');
        throw error;
      }
    }),
  };
  return { db, tx, log };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createDeferredTransaction', () => {
  it('opens nothing until asked, and commit/rollback of nothing are no-ops', async () => {
    const { db, log } = fakeDb();
    const transaction = createDeferredTransaction(db as never);
    expect(transaction.started()).toBe(false);
    await transaction.commit();
    await transaction.rollback();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('opens once for concurrent callers and commits when told to', async () => {
    const { db, tx, log } = fakeDb();
    const transaction = createDeferredTransaction(db as never);
    const [a, b] = await Promise.all([transaction.open(), transaction.open()]);
    expect(a).toBe(tx);
    expect(b).toBe(tx);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(log).toEqual(['BEGIN']);
    await transaction.commit();
    expect(log).toEqual(['BEGIN', 'COMMIT']);
  });

  it('rolls back an open transaction', async () => {
    const { db, log } = fakeDb();
    const transaction = createDeferredTransaction(db as never);
    await transaction.open();
    await transaction.rollback();
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('refuses with DataPoolAcquireTimeoutError when no connection frees in time, and gives the late one back', async () => {
    let free!: () => void;
    const { db, log } = fakeDb({ free: new Promise<void>((resolve) => (free = resolve)) });
    const transaction = createDeferredTransaction(db as never, 20);
    const error = await transaction.open().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataPoolAcquireTimeoutError);
    expect((error as DataPoolAcquireTimeoutError).metadata).toMatchObject({
      reason: 'pool-acquire-timeout',
      httpStatus: 503,
      retryAfter: 1,
      timeoutMs: 20,
    });
    expect(transaction.started()).toBe(false);
    // A commit after a failed open fails the call (the writes it was for never happened).
    await expect(transaction.commit()).rejects.toBeInstanceOf(DataPoolAcquireTimeoutError);
    free();
    await flush();
    await flush();
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('a rollback while still waiting gives up the open; BEGIN rolls back when it runs', async () => {
    let free!: () => void;
    const { db, log } = fakeDb({ free: new Promise<void>((resolve) => (free = resolve)) });
    const transaction = createDeferredTransaction(db as never);
    const opening = transaction.open().catch((e: unknown) => e);
    await transaction.rollback();
    free();
    expect(await opening).toBeInstanceOf(Error);
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('a failed COMMIT rejects commit()', async () => {
    const db = {
      transaction: vi.fn(async (cb: (handle: unknown) => Promise<unknown>) => {
        await cb({});
        throw new Error('could not serialize access');
      }),
    };
    const transaction = createDeferredTransaction(db as never);
    await transaction.open();
    await expect(transaction.commit()).rejects.toThrow('could not serialize access');
  });
});

function runnerFor(db: unknown, audit = { record: vi.fn(async () => undefined) }) {
  const outer = { Note: { findMany: vi.fn(async () => ['pool-row']) } };
  const inTx = {
    Note: {
      findMany: vi.fn(async () => ['tx-row']),
      create: vi.fn(async (row: unknown) => row),
    },
  };
  const entities = {
    getAllEntities: () => [{ name: 'Note' }],
    createDataService: vi.fn(({ db: handle }: { db: { label: string } }) =>
      handle.label === 'tx' ? inTx : outer,
    ),
  };
  const runner = createTransactionRunner({
    db: db as never,
    entities: entities as never,
    events: { get: () => undefined } as never,
    getAuth: () => ({ userId: 'u1', roles: [], scopes: [], provider: 'test' }),
    getAudit: () => audit as never,
  });
  return { runner, outer, inTx, entities };
}

describe('createTransactionRunner with begin: lazy', () => {
  it('never opens a transaction for a function that only reads; reads run on the pool', async () => {
    const { db, log } = fakeDb();
    const { runner, outer } = runnerFor(db);
    const rows = await runner(async (scope) => scope.data.Note?.findMany({}), { begin: 'lazy' });
    expect(rows).toEqual(['pool-row']);
    expect(outer.Note.findMany).toHaveBeenCalledOnce();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('opens at the first write; later reads run in the transaction; commits at the end', async () => {
    const { db, log } = fakeDb();
    const { runner, inTx } = runnerFor(db);
    const seen: unknown[] = [];
    await runner(
      async (scope: TransactionScope) => {
        seen.push(await scope.data.Note?.findMany({}));
        expect(scope.db).toBeUndefined();
        await scope.data.Note?.create({ title: 'a' });
        expect(scope.db).toEqual({ label: 'tx' });
        seen.push(await scope.data.Note?.findMany({}));
        expect(log).toEqual(['BEGIN']);
      },
      { begin: 'lazy' },
    );
    expect(seen).toEqual([['pool-row'], ['tx-row']]);
    expect(inTx.Note.create).toHaveBeenCalledWith({ title: 'a' });
    expect(log).toEqual(['BEGIN', 'COMMIT']);
  });

  it('rolls back what was opened when the function throws', async () => {
    const { db, log } = fakeDb();
    const { runner } = runnerFor(db);
    await expect(
      runner(
        async (scope) => {
          await scope.data.Note?.create({ title: 'a' });
          throw new Error('boom');
        },
        { begin: 'lazy' },
      ),
    ).rejects.toThrow('boom');
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('acquire() opens the transaction (durable flow starts, jobs, raw handles)', async () => {
    const { db, tx, log } = fakeDb();
    const { runner } = runnerFor(db);
    await runner(
      async (scope) => {
        expect(scope.isOpen?.()).toBe(false);
        expect(await scope.acquire?.()).toBe(tx);
        expect(scope.isOpen?.()).toBe(true);
      },
      { begin: 'lazy' },
    );
    expect(log).toEqual(['BEGIN', 'COMMIT']);
  });

  it('an empty emitMany opens nothing; emit opens the transaction', async () => {
    const { db, log } = fakeDb();
    const { runner } = runnerFor(db);
    await runner(
      async (scope) => {
        await scope.events.emitMany([]);
        expect(log).toEqual([]);
        // No registry entry and a fake tx: the insert fails, but only after BEGIN.
        await scope.events.emit('note.created' as never, {} as never).catch(() => undefined);
        expect(log).toEqual(['BEGIN']);
      },
      { begin: 'lazy' },
    ).catch(() => undefined);
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it('without options the runner opens before the function, as it always did', async () => {
    const { db, tx, log } = fakeDb();
    const { runner } = runnerFor(db);
    await runner(async (scope) => {
      expect(log).toEqual(['BEGIN']);
      expect(scope.db).toBe(tx);
    });
    expect(log).toEqual(['BEGIN', 'COMMIT']);
  });

  it('holds success records made before the open and drops them when the function throws', async () => {
    const auditDb = { insert: vi.fn() };
    const { db } = fakeDb();
    const writes: Array<{ action: string; outcome: string }> = [];
    const audit = createAuditService({
      db: auditDb as never,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
    });
    // Observe the outer writer through record(): the default service writes via its db.
    const record = vi.spyOn(audit, 'record').mockImplementation(async (action, metadata) => {
      writes.push({ action, outcome: String(metadata?.outcome ?? 'success') });
    });
    const { runner } = runnerFor(db, audit as never);
    await expect(
      runner(
        async (scope) => {
          await scope.audit?.record('note.success', { outcome: 'success' });
          await scope.audit?.record('note.denied', { outcome: 'denied' });
          throw new Error('boom');
        },
        { begin: 'lazy' },
      ),
    ).rejects.toThrow('boom');
    expect(writes).toEqual([{ action: 'note.denied', outcome: 'denied' }]);
    record.mockRestore();
  });

  it('writes held success records through the outer service when nothing opened the transaction', async () => {
    const { db } = fakeDb();
    const inserted: Array<{ action: string; outcome: string }> = [];
    // The default service's writer: insert(auditRecords).values(rows).onConflictDoNothing().
    const auditDb = {
      insert: () => ({
        values: (rows: unknown) => ({
          onConflictDoNothing: async () => {
            for (const row of [rows].flat() as Array<{ action: string; outcome: string }>) {
              inserted.push({ action: row.action, outcome: row.outcome });
            }
          },
        }),
      }),
    };
    const audit = createAuditService({
      db: auditDb as never,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
    });
    const { runner } = runnerFor(db, audit as never);
    await runner(
      async (scope) => {
        await scope.audit?.record('note.success', { outcome: 'success' });
        await scope.audit?.recordMany?.([
          { eventType: 'note.many', metadata: { outcome: 'success' } },
          { eventType: 'note.refused', metadata: { outcome: 'denied' } },
        ]);
        // The refusal stands at once; the success records wait.
        expect(inserted).toEqual([{ action: 'note.refused', outcome: 'denied' }]);
      },
      { begin: 'lazy' },
    );
    expect(inserted).toEqual([
      { action: 'note.refused', outcome: 'denied' },
      { action: 'note.success', outcome: 'success' },
      { action: 'note.many', outcome: 'success' },
    ]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a held success record that cannot be written after the call does not fail it: retried, then reported', async () => {
    const { db } = fakeDb();
    let failing = true;
    const inserted: string[] = [];
    const auditDb = {
      insert: () => ({
        values: (rows: unknown) => ({
          onConflictDoNothing: async () => {
            if (failing) throw new Error('audit store offline');
            for (const row of [rows].flat() as Array<{ action: string }>) inserted.push(row.action);
          },
        }),
      }),
    };
    const failures: Array<{ final: boolean; attempts: number }> = [];
    const audit = createAuditService({
      db: auditDb as never,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
      retryDelaysMs: [5, 5],
      onWriteFailure: ({ final, attempts }) => failures.push({ final, attempts }),
    });
    const { runner } = runnerFor(db, audit as never);
    const result = await runner(
      async (scope) => {
        await scope.audit?.record('note.success', { outcome: 'success' });
        return 'done';
      },
      { begin: 'lazy' },
    );
    expect(result).toBe('done');
    expect(failures).toEqual([{ final: false, attempts: 1 }]);
    failing = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inserted).toEqual(['note.success']);
  });

  it('deleteMany and updateMany are writes: they open the transaction and run in it', async () => {
    const { db, log } = fakeDb();
    const { runner, inTx } = runnerFor(db);
    const deleteMany = vi.fn(async () => ({ count: 2, ids: ['a', 'b'] }));
    const updateMany = vi.fn(async () => ({ count: 1, ids: ['c'] }));
    Object.assign(inTx.Note, { deleteMany, updateMany });
    await runner(
      async (scope) => {
        const repo = scope.data.Note as unknown as {
          deleteMany: (q: unknown, o: unknown) => Promise<unknown>;
          updateMany: (q: unknown, v: unknown, o: unknown) => Promise<unknown>;
        };
        expect(await repo.deleteMany({ state: 'old' }, { limit: 10 })).toEqual({
          count: 2,
          ids: ['a', 'b'],
        });
        expect(log).toEqual(['BEGIN']);
        await repo.updateMany({ state: 'new' }, { state: 'seen' }, { limit: 10 });
      },
      { begin: 'lazy' },
    );
    expect(deleteMany).toHaveBeenCalledWith({ state: 'old' }, { limit: 10 });
    expect(updateMany).toHaveBeenCalledWith({ state: 'new' }, { state: 'seen' }, { limit: 10 });
    expect(log).toEqual(['BEGIN', 'COMMIT']);
  });
});

function capability(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'doThing',
    kind: 'action',
    domain: 'orders',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    audit: { enabled: false, event: 'unused' },
    handler: async () => ({ ok: true }),
    ...overrides,
  } as CapabilityContract;
}

describe('resolveTransactionRunOptions', () => {
  const ctx = (config: Record<string, unknown> = {}) =>
    createExecutionContext({
      auth: { userId: 'u', roles: [], scopes: [], provider: 'test' },
      data: {},
      config,
    });

  it('defaults to lazy with a 10 s wait', () => {
    expect(resolveTransactionRunOptions(capability(), ctx())).toEqual({
      begin: 'lazy',
      acquireTimeoutMs: 10_000,
    });
  });

  it('follows the host, and the capability over the host', () => {
    const eagerHost = ctx({
      execution: { transactionBegin: 'eager', transactionAcquireTimeoutMs: 0 },
    });
    expect(resolveTransactionRunOptions(capability(), eagerHost)).toEqual({
      begin: 'eager',
      acquireTimeoutMs: 0,
    });
    expect(
      resolveTransactionRunOptions(capability({ transactional: 'lazy' }), eagerHost).begin,
    ).toBe('lazy');
    expect(resolveTransactionRunOptions(capability({ transactional: 'eager' }), ctx()).begin).toBe(
      'eager',
    );
    expect(resolveTransactionRunOptions(capability({ transactional: true }), eagerHost).begin).toBe(
      'eager',
    );
  });
});

describe('executeCapability with a lazily opened transaction', () => {
  function context(db: unknown, extra: Record<string, unknown> = {}) {
    const { runner } = runnerFor(db);
    return createExecutionContext({
      auth: { userId: 'u', roles: ['admin'], scopes: [], provider: 'test' },
      data: {},
      config: {},
      withTransaction: runner,
      ...extra,
    });
  }

  it('does not call beforeCommit (the idempotency completion) when nothing opened the transaction', async () => {
    const { db } = fakeDb();
    const beforeCommit = vi.fn(async () => undefined);
    const result = await executeCapability(capability(), context(db), {}, { beforeCommit });
    expect(result.success).toBe(true);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('calls beforeCommit inside the transaction once the handler opened it', async () => {
    const { db, tx, log } = fakeDb();
    const beforeCommit = vi.fn(async () => {
      log.push('completion');
    });
    const cap = capability({
      handler: async (ctx) => {
        await ctx.data.Note?.create({ title: 'a' });
        return { ok: true };
      },
    });
    await executeCapability(cap, context(db), {}, { beforeCommit });
    expect(beforeCommit).toHaveBeenCalledWith(tx, { ok: true });
    expect(log).toEqual(['BEGIN', 'completion', 'COMMIT']);
  });

  it('a durable flow start opens the transaction and runs after commit', async () => {
    const { db, log } = fakeDb();
    const flows = {
      start: vi.fn(async () => {
        log.push('flow.start');
        return { id: 'x', flowName: 'f', status: 'running' };
      }),
    } as unknown as FlowService;
    const cap = capability({
      handler: async (ctx) => {
        await ctx.flows.start('f' as never, {});
        return { ok: true };
      },
    });
    // The fake tx cannot answer the intent-table probe: the start falls back to post-commit.
    await executeCapability(cap, context(db, { flows }), {});
    expect(log).toEqual(['BEGIN', 'COMMIT', 'flow.start']);
  });

  it('a job enqueue opens the transaction and writes its intent there', async () => {
    const { db, tx, log } = fakeDb();
    const enqueue = vi.fn(async () => 'job-1');
    const inTransaction = vi.fn(() => ({ enqueue }));
    const jobs = { enqueue: vi.fn(), inTransaction };
    const cap = capability({
      handler: async (ctx) => {
        await ctx.jobs.enqueue('orders.later', {});
        return { ok: true };
      },
    });
    await executeCapability(cap, context(db, { jobs }), {});
    expect(inTransaction).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(enqueue).toHaveBeenCalledOnce();
    expect(log).toEqual(['BEGIN', 'COMMIT']);
  });
});

describe('createDeferredFlowService with acquire', () => {
  it('opens through acquire only when a flow is started', async () => {
    const acquire = vi.fn(async () => ({ execute: vi.fn(async () => []) }) as never);
    const deferred: Array<() => Promise<void>> = [];
    const service = createDeferredFlowService(
      { start: vi.fn() } as unknown as FlowService,
      deferred,
      () => 'id-1',
      {
        acquire,
        planeDb: {} as never,
        auth: { userId: 'u', roles: [], scopes: [], provider: 't' },
      },
    );
    expect(acquire).not.toHaveBeenCalled();
    await service.start('f' as never, {});
    expect(acquire).toHaveBeenCalledOnce();
    expect(deferred).toHaveLength(1);
  });
});
