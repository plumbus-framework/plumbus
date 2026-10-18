import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { FlowService, TransactionScope } from '../../types/context.js';
import { PlumbusError } from '../../errors/index.js';
import { CapabilityRegistry } from '../capability-registry.js';
import { executeCapability } from '../capability-executor.js';
import { buildCapabilityRuntimeDeps } from '../capability-invocation.js';
import { createExecutionContext } from '../context-factory.js';

function makeActionCap(handler: CapabilityContract['handler']): CapabilityContract {
  return {
    name: 'orders.startChild',
    kind: 'action',
    domain: 'orders',
    input: z.object({}),
    output: z.object({ flowId: z.string() }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    handler,
  } as CapabilityContract;
}

describe('deferred flow dispatch inside transactional handlers', () => {
  it('returns the same flow id before and after commit', async () => {
    const deferred: Array<() => Promise<void>> = [];
    let startedId: string | undefined;

    const flows: FlowService = {
      start: vi.fn(async (_flowName, _input, opts) => {
        startedId = opts?.executionId;
        return { id: opts?.executionId ?? 'missing', flowName: 'child', status: 'created' };
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
      terminate: vi.fn(),
      status: vi.fn(),
      wake: vi.fn(),
      heartbeat: vi.fn(),
    };

    const cap = makeActionCap(async (ctx) => {
      const exec = await ctx.flows.start('child.flow', { id: '1' });
      return { flowId: exec.id };
    });

    const withTransaction = vi.fn(async <T>(fn: (scope: TransactionScope) => Promise<T>) => {
      const scope: TransactionScope = {
        data: {} as never,
        events: { emit: vi.fn(), emitMany: vi.fn() },
        deferred,
      };
      const result = await fn(scope);
      for (const callback of deferred) {
        await callback();
      }
      return result;
    });

    const registry = new CapabilityRegistry();
    registry.register(cap);
    const ctx = createExecutionContext({
      audit: { record: vi.fn(async () => {}) },
      auth: { userId: 'u1', roles: ['admin'], scopes: [], provider: 'test', tenantId: 't1' },
      data: {},
      flows,
      withTransaction,
      ...buildCapabilityRuntimeDeps(registry),
    });

    const result = await executeCapability(cap, ctx, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.flowId).toBe(startedId);
      expect(flows.start).toHaveBeenCalledOnce();
    }
  });

  it('wakes a sleeping execution only after the transaction commits', async () => {
    const deferred: Array<() => Promise<void>> = [];
    const order: string[] = [];
    const flows: FlowService = {
      start: vi.fn(async (_flowName, _input, opts) => ({
        id: opts?.executionId ?? 'missing',
        flowName: 'child',
        status: 'created',
      })),
      resume: vi.fn(),
      cancel: vi.fn(),
      terminate: vi.fn(),
      status: vi.fn(),
      wake: vi.fn(async (executionId: string) => {
        order.push(`wake:${executionId}`);
        return { executionId, woken: true, status: 'waiting' };
      }),
      heartbeat: vi.fn(),
    };
    const answers: unknown[] = [];
    const cap = makeActionCap(async (ctx) => {
      answers.push(await ctx.flows.wake('sleeping-1'));
      // An execution this transaction starts is not waiting yet.
      const child = await ctx.flows.start('child.flow', {});
      answers.push(await ctx.flows.wake(child.id));
      order.push('handler-done');
      return { flowId: child.id };
    });
    const withTransaction = vi.fn(async <T>(fn: (scope: TransactionScope) => Promise<T>) => {
      const scope: TransactionScope = {
        data: {} as never,
        events: { emit: vi.fn(), emitMany: vi.fn() },
        deferred,
      };
      const result = await fn(scope);
      order.push('commit');
      for (const callback of deferred) await callback();
      return result;
    });
    const registry = new CapabilityRegistry();
    registry.register(cap);
    const ctx = createExecutionContext({
      audit: { record: vi.fn(async () => {}) },
      auth: { userId: 'u1', roles: ['admin'], scopes: [], provider: 'test', tenantId: 't1' },
      data: {},
      flows,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      withTransaction,
      ...buildCapabilityRuntimeDeps(registry),
    });

    const result = await executeCapability(cap, ctx, {});
    expect(result.success).toBe(true);
    expect(answers[0]).toEqual({
      executionId: 'sleeping-1',
      woken: false,
      deferred: true,
      status: 'pending',
    });
    expect(answers[1]).toMatchObject({ woken: false, reason: 'not-waiting', status: 'pending' });
    expect(order).toEqual(['handler-done', 'commit', 'wake:sleeping-1']);
    expect(flows.wake).toHaveBeenCalledOnce();
  });

  it("logs each wake's outcome after commit through the capability's logger, a refusal included", async () => {
    const deferred: Array<() => Promise<void>> = [];
    const sleeping = '11111111-1111-4111-8111-111111111111';
    const foreign = '22222222-2222-4222-8222-222222222222';
    const flows: FlowService = {
      start: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      terminate: vi.fn(),
      status: vi.fn(),
      wake: vi.fn(async (executionId: string) => {
        if (executionId === sleeping) return { executionId, woken: true, status: 'waiting' };
        throw new PlumbusError('notFound', `Flow execution "${executionId}" not found`, {
          executionId,
          reason: 'flow-execution-not-found',
        });
      }),
      heartbeat: vi.fn(),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cap = makeActionCap(async (ctx) => {
      await ctx.flows.wake(sleeping);
      await ctx.flows.wake(foreign);
      await ctx.flows.wake(`${'x'.repeat(2048)}-caller-marker`);
      return { flowId: sleeping };
    });
    let callbackError: unknown;
    const withTransaction = vi.fn(async <T>(fn: (scope: TransactionScope) => Promise<T>) => {
      const scope: TransactionScope = {
        data: {} as never,
        events: { emit: vi.fn(), emitMany: vi.fn() },
        deferred,
      };
      const result = await fn(scope);
      for (const callback of deferred) {
        await callback().catch((error: unknown) => {
          callbackError = error;
        });
      }
      return result;
    });
    const registry = new CapabilityRegistry();
    registry.register(cap);
    const ctx = createExecutionContext({
      audit: { record: vi.fn(async () => {}) },
      auth: { userId: 'u1', roles: ['admin'], scopes: [], provider: 'test', tenantId: 't1' },
      data: {},
      flows,
      logger,
      withTransaction,
      ...buildCapabilityRuntimeDeps(registry),
    });

    const result = await executeCapability(cap, ctx, {});
    expect(result.success).toBe(true);
    // A refusal after commit is logged, not thrown: the caller already has its answer.
    expect(callbackError).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('flow wake after commit', {
      executionId: sleeping,
      woken: true,
      status: 'waiting',
    });
    expect(logger.warn).toHaveBeenCalledWith('flow wake after commit failed', {
      executionId: foreign,
      code: 'notFound',
      reason: 'flow-execution-not-found',
    });
    expect(logger.warn).toHaveBeenCalledWith('flow wake after commit failed', {
      executionId: '(malformed)',
      code: 'notFound',
      reason: 'flow-execution-not-found',
    });
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(
      'caller-marker',
    );
  });

  it('wakes nothing when the transaction rolls back', async () => {
    const deferred: Array<() => Promise<void>> = [];
    const flows: FlowService = {
      start: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      terminate: vi.fn(),
      status: vi.fn(),
      wake: vi.fn(),
      heartbeat: vi.fn(),
    };
    const cap = makeActionCap(async (ctx) => {
      await ctx.flows.wake('sleeping-1');
      throw new Error('business rule failed');
    });
    const withTransaction = vi.fn(async <T>(fn: (scope: TransactionScope) => Promise<T>) => {
      const scope: TransactionScope = {
        data: {} as never,
        events: { emit: vi.fn(), emitMany: vi.fn() },
        deferred,
      };
      // A rollback never runs the post-commit callbacks.
      return fn(scope);
    });
    const registry = new CapabilityRegistry();
    registry.register(cap);
    const ctx = createExecutionContext({
      audit: { record: vi.fn(async () => {}) },
      auth: { userId: 'u1', roles: ['admin'], scopes: [], provider: 'test', tenantId: 't1' },
      data: {},
      flows,
      withTransaction,
      ...buildCapabilityRuntimeDeps(registry),
    });

    const result = await executeCapability(cap, ctx, {});
    expect(result.success).toBe(false);
    expect(deferred).toHaveLength(1);
    expect(flows.wake).not.toHaveBeenCalled();
  });
});
