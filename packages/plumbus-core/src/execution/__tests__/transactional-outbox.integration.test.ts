import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry } from '../capability-registry.js';
import { executeCapability } from '../capability-executor.js';
import { buildCapabilityRuntimeDeps } from '../capability-invocation.js';
import { createExecutionContext } from '../context-factory.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { AuthContext } from '../../types/security.js';
import type { TransactionScope } from '../../types/context.js';

function makeAuth(): AuthContext {
  return {
    userId: 'user-1',
    roles: ['admin'],
    scopes: ['read', 'write'],
    provider: 'test',
    tenantId: 'tenant-1',
  };
}

function makeActionCap(
  handler: CapabilityContract['handler'],
  overrides: Partial<CapabilityContract> = {},
): CapabilityContract {
  return {
    name: 'createOrder',
    kind: 'action',
    domain: 'orders',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    effects: { data: ['Order'], events: ['order.created'], external: [], ai: false },
    access: { roles: ['admin'] },
    handler,
    ...overrides,
  } as CapabilityContract;
}

function createTransactionalCtx(options?: {
  withTransaction?: ReturnType<typeof vi.fn>;
  config?: Record<string, unknown>;
  capabilities?: CapabilityContract[];
}) {
  const withTransaction =
    options?.withTransaction ??
    vi.fn(async <T>(fn: (scope: TransactionScope) => Promise<T>) => {
      const scope: TransactionScope = {
        data: { Order: { create: vi.fn() } } as never,
        events: {
          emit: vi.fn(),
          emitMany: vi.fn(),
        },
      };
      return fn(scope);
    });

  const capRuntime =
    options?.capabilities && options.capabilities.length > 0
      ? (() => {
          const registry = new CapabilityRegistry();
          registry.registerAll(options.capabilities);
          return buildCapabilityRuntimeDeps(registry);
        })()
      : {};

  const ctx = createExecutionContext({
    auth: makeAuth(),
    data: {},
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    config: options?.config ?? {},
    withTransaction,
    ...capRuntime,
  });

  return { ctx, withTransaction };
}

describe('executeCapability transactional outbox integration', () => {
  it('wraps action handler and output validation in withTransaction', async () => {
    const handler = vi.fn(async () => ({ id: 'o1' }));
    const cap = makeActionCap(handler);
    const { ctx, withTransaction } = createTransactionalCtx();

    const result = await executeCapability(cap, ctx, { id: 'o1' });

    expect(result.success).toBe(true);
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rolls back when handler throws (withTransaction propagates error)', async () => {
    const cap = makeActionCap(async () => {
      throw new Error('boom');
    });
    const withTransaction = vi.fn(async <T>(fn: (scope: TransactionScope) => Promise<T>) => {
      const scope: TransactionScope = {
        data: {} as never,
        events: { emit: vi.fn(), emitMany: vi.fn() },
      };
      return fn(scope);
    });
    const { ctx } = createTransactionalCtx({ withTransaction });

    const result = await executeCapability(cap, ctx, { id: 'o1' });

    expect(result.success).toBe(false);
    expect(withTransaction).toHaveBeenCalledOnce();
    if (!result.success) {
      expect(result.error.code).toBe('internal');
    }
  });

  it('rolls back on invalid output inside the transaction', async () => {
    const cap = makeActionCap(async () => ({ id: 123 }) as never);
    const { ctx, withTransaction } = createTransactionalCtx();

    const result = await executeCapability(cap, ctx, { id: 'o1' });

    expect(result.success).toBe(false);
    expect(withTransaction).toHaveBeenCalledOnce();
    if (!result.success) {
      expect(result.error.code).toBe('internal');
    }
  });

  it('nested ctx.capabilities.invoke shares the active transaction scope', async () => {
    const childHandler = vi.fn(async () => ({ id: 'child' }));
    const child = makeActionCap(childHandler, {
      name: 'childStep',
      effects: {
        data: [],
        events: [],
        external: [],
        ai: false,
        capabilities: [],
      },
    });
    child.effects.capabilities = [];

    const parent = makeActionCap(
      async (handlerCtx, input) => {
        await handlerCtx.capabilities.invoke('orders.childStep', { id: input.id });
        return { id: input.id };
      },
      {
        effects: {
          data: ['Order'],
          events: [],
          external: [],
          ai: false,
          capabilities: ['orders.childStep'],
        },
      },
    );

    const withTransaction = vi.fn(async <T>(fn: (scope: TransactionScope) => Promise<T>) => {
      const scope: TransactionScope = {
        data: {} as never,
        events: { emit: vi.fn(), emitMany: vi.fn() },
      };
      return fn(scope);
    });

    const { ctx } = createTransactionalCtx({
      withTransaction,
      capabilities: [parent, child],
    });

    const result = await executeCapability(parent, ctx, { id: 'o1' });

    expect(result.success).toBe(true);
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(childHandler).toHaveBeenCalledOnce();
  });

  it('does not use withTransaction for query capabilities', async () => {
    const cap = makeActionCap(async (_ctx, input) => ({ id: input.id }), { kind: 'query' });
    const { ctx, withTransaction } = createTransactionalCtx();

    await executeCapability(cap, ctx, { id: 'o1' });

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('does not use withTransaction for job capabilities', async () => {
    const cap = makeActionCap(async (_ctx, input) => ({ id: input.id }), { kind: 'job' });
    const { ctx, withTransaction } = createTransactionalCtx();

    await executeCapability(cap, ctx, { id: 'o1' });

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('does not use withTransaction when effects.ai is true', async () => {
    const cap = makeActionCap(async (_ctx, input) => ({ id: input.id }), {
      effects: { data: [], events: [], external: [], ai: true },
    });
    const { ctx, withTransaction } = createTransactionalCtx();

    await executeCapability(cap, ctx, { id: 'o1' });

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('does not use withTransaction when capability opts out', async () => {
    const cap = makeActionCap(async (_ctx, input) => ({ id: input.id }), {
      transactional: false,
    });
    const { ctx, withTransaction } = createTransactionalCtx();

    await executeCapability(cap, ctx, { id: 'o1' });

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('does not use withTransaction when effects.external is set', async () => {
    const cap = makeActionCap(async (_ctx, input) => ({ id: input.id }), {
      effects: { data: [], events: [], external: ['stripe'], ai: false },
    });
    const { ctx, withTransaction } = createTransactionalCtx();

    await executeCapability(cap, ctx, { id: 'o1' });

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('re-throws nested handler failures to poison the parent transaction scope', async () => {
    const child = makeActionCap(
      async () => {
        throw new Error('child failed');
      },
      {
        name: 'childStep',
        effects: { data: [], events: [], external: [], ai: false, capabilities: [] },
      },
    );

    const parent = makeActionCap(
      async (handlerCtx, input) => {
        await handlerCtx.capabilities.invoke('orders.childStep', { id: input.id });
        return { id: input.id };
      },
      {
        effects: {
          data: ['Order'],
          events: [],
          external: [],
          ai: false,
          capabilities: ['orders.childStep'],
        },
      },
    );

    let txThrows = false;
    const withTransaction = vi.fn(async <T>(fn: (scope: TransactionScope) => Promise<T>) => {
      try {
        const scope: TransactionScope = {
          data: {} as never,
          events: { emit: vi.fn(), emitMany: vi.fn() },
        };
        return await fn(scope);
      } catch {
        txThrows = true;
        throw new Error('tx rollback');
      }
    });

    const { ctx } = createTransactionalCtx({
      withTransaction,
      capabilities: [parent, child],
    });

    const result = await executeCapability(parent, ctx, { id: 'o1' });
    expect(result.success).toBe(false);
    expect(txThrows).toBe(true);
  });

  it('does not use withTransaction when global kill switch is set', async () => {
    const cap = makeActionCap(async (_ctx, input) => ({ id: input.id }));
    const { ctx, withTransaction } = createTransactionalCtx({
      config: { execution: { transactionalOutbox: false } },
    });

    await executeCapability(cap, ctx, { id: 'o1' });

    expect(withTransaction).not.toHaveBeenCalled();
  });
});
