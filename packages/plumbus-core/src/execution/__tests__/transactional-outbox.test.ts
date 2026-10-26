import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { ExecutionContext } from '../../types/context.js';
import { createAuditService } from '../../audit/index.js';
import { createExecutionContext } from '../context-factory.js';
import { createTransactionRunner, shouldUseTransactionalOutbox } from '../transactional-outbox.js';

function makeCapability(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'doThing',
    kind: 'action',
    domain: 'orders',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    effects: { data: ['Order'], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
    ...overrides,
  } as CapabilityContract;
}

function makeCtx(config: Record<string, unknown> = {}): ExecutionContext {
  return createExecutionContext({
    auth: {
      userId: 'u1',
      roles: ['admin'],
      scopes: [],
      provider: 'test',
      tenantId: 't1',
    },
    data: {},
    config,
  });
}

describe('shouldUseTransactionalOutbox', () => {
  it('defaults ON for action capabilities', () => {
    expect(shouldUseTransactionalOutbox(makeCapability({ kind: 'action' }), makeCtx())).toBe(true);
  });

  it('defaults ON for eventHandler capabilities', () => {
    expect(shouldUseTransactionalOutbox(makeCapability({ kind: 'eventHandler' }), makeCtx())).toBe(
      true,
    );
  });

  it('is OFF for query capabilities', () => {
    expect(shouldUseTransactionalOutbox(makeCapability({ kind: 'query' }), makeCtx())).toBe(false);
  });

  it('auto-excludes job kind', () => {
    expect(shouldUseTransactionalOutbox(makeCapability({ kind: 'job' }), makeCtx())).toBe(false);
  });

  it('auto-excludes capabilities with effects.ai: true', () => {
    expect(
      shouldUseTransactionalOutbox(
        makeCapability({
          kind: 'action',
          effects: { data: [], events: [], external: [], ai: true },
        }),
        makeCtx(),
      ),
    ).toBe(false);
  });

  it('auto-excludes capabilities with effects.external', () => {
    expect(
      shouldUseTransactionalOutbox(
        makeCapability({
          kind: 'action',
          effects: { data: [], events: [], external: ['payment-api'], ai: false },
        }),
        makeCtx(),
      ),
    ).toBe(false);
  });

  it('respects per-capability transactional: false', () => {
    expect(
      shouldUseTransactionalOutbox(
        makeCapability({ kind: 'action', transactional: false }),
        makeCtx(),
      ),
    ).toBe(false);
  });

  it('respects global execution.transactionalOutbox: false kill switch', () => {
    expect(
      shouldUseTransactionalOutbox(
        makeCapability({ kind: 'action' }),
        makeCtx({ execution: { transactionalOutbox: false } }),
      ),
    ).toBe(false);
  });
});

describe('createTransactionRunner', () => {
  it('runs callback inside db.transaction with tx-scoped data and events', async () => {
    const outerAudit = { record: vi.fn() };
    const txDb = { label: 'tx' } as never;

    const entities = {
      createDataService: vi.fn(({ db }) => ({ dbLabel: (db as { label: string }).label })),
    };
    const events = {
      get: vi.fn(),
    };

    const db = {
      transaction: vi.fn(async (fn: (tx: typeof txDb) => Promise<unknown>) => fn(txDb)),
    } as never;

    const runner = createTransactionRunner({
      db,
      entities: entities as never,
      events: events as never,
      getAuth: () => ({
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
      }),
      getAudit: () => outerAudit as never,
    });

    const scope = await runner(async (s) => s);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(entities.createDataService).toHaveBeenCalledWith(
      expect.objectContaining({ db: txDb, audit: outerAudit }),
    );
    expect(scope.data).toEqual({ dbLabel: 'tx' });
    expect(scope.events).toBeDefined();
  });

  it('propagates rollback when callback throws', async () => {
    const db = {
      transaction: vi.fn(async (fn: (tx: never) => Promise<unknown>) => fn({} as never)),
    } as never;

    const runner = createTransactionRunner({
      db,
      entities: { createDataService: vi.fn(() => ({})) } as never,
      events: { get: vi.fn() } as never,
      getAuth: () => ({
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
      }),
      getAudit: () => ({ record: vi.fn() }) as never,
    });

    await expect(
      runner(async () => {
        throw new Error('rollback me');
      }),
    ).rejects.toThrow('rollback me');
  });

  it('isolates deferred post-commit failures so remaining callbacks still run', async () => {
    const db = {
      transaction: vi.fn(async (fn: (tx: never) => Promise<unknown>) => fn({} as never)),
    } as never;

    const runner = createTransactionRunner({
      db,
      entities: { createDataService: vi.fn(() => ({})) } as never,
      events: { get: vi.fn() } as never,
      getAuth: () => ({
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
      }),
      getAudit: () => ({ record: vi.fn() }) as never,
    });

    const second = vi.fn(async () => undefined);
    const result = await runner(async (scope) => {
      scope.deferred?.push(async () => {
        throw new Error('deferred boom');
      });
      scope.deferred?.push(second);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(second).toHaveBeenCalledOnce();
  });

  describe('audit bound to the transaction', () => {
    const auth = { userId: 'u1', roles: [], scopes: [], provider: 'test' } as const;

    /** A fake database whose inserts are recorded per handle ('outer' or 'tx'). */
    function makeDb(options: { rollback?: boolean } = {}) {
      const writes: Array<{ via: string; action: string; outcome: string; id: string }> = [];
      const handle = (via: string) => ({
        via,
        insert: vi.fn(() => ({
          values: vi.fn((row: { action: string; outcome: string; id: string }) => ({
            onConflictDoNothing: async () => {
              writes.push({ via, action: row.action, outcome: row.outcome, id: row.id });
            },
          })),
        })),
      });
      const tx = handle('tx');
      const db = {
        ...handle('outer'),
        transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
          const before = writes.length;
          try {
            return await fn(tx);
          } catch (err) {
            // A rollback discards what the transaction wrote.
            if (options.rollback !== false) {
              for (let i = writes.length - 1; i >= before; i--) {
                if (writes[i]?.via === 'tx') writes.splice(i, 1);
              }
            }
            throw err;
          }
        }),
      };
      return { db, writes };
    }

    function runnerFor(db: unknown, audit: unknown) {
      return createTransactionRunner({
        db: db as never,
        entities: {
          createDataService: vi.fn(({ audit: scopedAudit }) => ({ scopedAudit })),
        } as never,
        events: { get: vi.fn() } as never,
        getAuth: () => auth,
        getAudit: () => audit as never,
      });
    }

    it('gives scope data, events and scope.audit a service that writes through tx', async () => {
      const { db, writes } = makeDb();
      const outerAudit = createAuditService({ db: db as never, auth });
      const runner = runnerFor(db, outerAudit);

      const scope = await runner(async (s) => {
        await s.audit?.record('inside');
        return s;
      });

      expect(scope.audit).toBeDefined();
      expect(scope.audit).not.toBe(outerAudit);
      expect((scope.data as unknown as { scopedAudit: unknown }).scopedAudit).toBe(scope.audit);
      expect(writes).toEqual([expect.objectContaining({ via: 'tx', action: 'inside' })]);
    });

    it('replays failure/denied through the outer writer after a rollback; drops success', async () => {
      const { db, writes } = makeDb();
      const runner = runnerFor(db, createAuditService({ db: db as never, auth }));

      await expect(
        runner(async (s) => {
          await s.audit?.record('ok');
          await s.audit?.record('broken', { outcome: 'failure' });
          await s.audit?.record('refused', { outcome: 'denied' });
          throw new Error('rollback me');
        }),
      ).rejects.toThrow('rollback me');

      expect(writes.map((w) => [w.via, w.action])).toEqual([
        ['outer', 'broken'],
        ['outer', 'refused'],
      ]);
    });

    it('routes post-commit deferred audits to the outer writer', async () => {
      const { db, writes } = makeDb();
      const runner = runnerFor(db, createAuditService({ db: db as never, auth }));

      await runner(async (s) => {
        const bound = s.audit;
        s.deferred?.push(async () => {
          await bound?.record('after.commit');
        });
        return 'ok';
      });

      expect(writes).toEqual([expect.objectContaining({ via: 'outer', action: 'after.commit' })]);
    });

    it('leaves a custom audit service on the outer path', async () => {
      const { db } = makeDb();
      const custom = { record: vi.fn(async () => undefined) };
      const runner = runnerFor(db, custom);

      const scope = await runner(async (s) => s);

      expect(scope.audit).toBe(custom);
    });
  });

  it('omits persist-before-ack helpers when durableDispatch is unset', async () => {
    const db = {
      transaction: vi.fn(async (fn: (tx: never) => Promise<unknown>) => fn({} as never)),
    } as never;

    const runner = createTransactionRunner({
      db,
      entities: { createDataService: vi.fn(() => ({})) } as never,
      events: { get: vi.fn() } as never,
      getAuth: () => ({
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
      }),
      getAudit: () => ({ record: vi.fn() }) as never,
    });

    const scope = await runner(async (s) => s);
    expect(scope.persistAcceptance).toBeUndefined();
    expect(scope.enqueueDispatch).toBeUndefined();
  });

  it('exposes persistAcceptance and enqueueDispatch when durableDispatch is set', async () => {
    const db = {
      transaction: vi.fn(async (fn: (tx: never) => Promise<unknown>) => fn({} as never)),
    } as never;

    const runner = createTransactionRunner({
      db,
      entities: { createDataService: vi.fn(() => ({})) } as never,
      events: { get: vi.fn() } as never,
      getAuth: () => ({
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
      }),
      getAudit: () => ({ record: vi.fn() }) as never,
      durableDispatch: { schemaName: 'core_plumbus' },
    });

    const scope = await runner(async (s) => s);
    expect(scope.persistAcceptance).toEqual(expect.any(Function));
    expect(scope.enqueueDispatch).toEqual(expect.any(Function));
  });
});
