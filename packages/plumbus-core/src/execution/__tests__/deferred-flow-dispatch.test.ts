import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { FlowService, TransactionScope } from '../../types/context.js';
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
      status: vi.fn(),
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
});
