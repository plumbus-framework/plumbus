import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { TransactionScope } from '../../types/context.js';
import { CapabilityRegistry } from '../capability-registry.js';
import { executeCapability } from '../capability-executor.js';
import { buildCapabilityRuntimeDeps } from '../capability-invocation.js';
import { createExecutionContext } from '../context-factory.js';
import type { JobDispatchService } from '../../jobs/job-dispatch-service.js';

function makeActionCap(handler: CapabilityContract['handler']): CapabilityContract {
  return {
    name: 'orders.enqueueChild',
    kind: 'action',
    domain: 'orders',
    input: z.object({}),
    output: z.object({ jobId: z.string() }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    handler,
  } as CapabilityContract;
}

describe('deferred job dispatch inside transactional handlers', () => {
  it('runs ctx.jobs.enqueue only after the transaction commits', async () => {
    const deferred: Array<() => Promise<void>> = [];
    let ranInsideTx = false;
    let enqueueAfterCommit = false;

    const jobs: JobDispatchService = {
      enqueue: vi.fn(async () => {
        if (ranInsideTx) {
          throw new Error('enqueue ran before commit');
        }
        enqueueAfterCommit = true;
        return 'job-123';
      }),
    };

    const cap = makeActionCap(async (ctx) => {
      ranInsideTx = true;
      const jobId = await ctx.jobs.enqueue('jobs.process', { id: '1' });
      ranInsideTx = false;
      return { jobId };
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
      jobs,
      withTransaction,
      ...buildCapabilityRuntimeDeps(registry),
    });

    const result = await executeCapability(cap, ctx, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    }
    expect(enqueueAfterCommit).toBe(true);
    expect(jobs.enqueue).toHaveBeenCalledOnce();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'jobs.process',
      { id: '1' },
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });
});
