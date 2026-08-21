import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { ExecutionContext } from '../../types/context.js';
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
