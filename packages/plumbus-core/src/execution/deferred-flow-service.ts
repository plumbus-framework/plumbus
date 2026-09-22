import type { FlowService } from '../types/context.js';

/**
 * Wraps a FlowService so `start` runs after the active transaction commits.
 * Returns a pre-allocated execution id immediately so handlers can await without deadlocking the tx.
 * `status`/`resume`/`cancel` for ids still pending commit return a pending handle (or no-op)
 * so callers do not hit not-found before the post-commit start runs.
 */
export function createDeferredFlowService(
  flows: FlowService,
  deferred: Array<() => Promise<void>>,
  allocExecutionId: () => string = () => crypto.randomUUID(),
): FlowService {
  const pending = new Map<string, { flowName: string }>();

  return {
    async start(flowName, input, opts) {
      const executionId = opts?.executionId ?? allocExecutionId();
      pending.set(executionId, { flowName });
      deferred.push(async () => {
        try {
          await flows.start(flowName, input, { executionId });
        } finally {
          pending.delete(executionId);
        }
      });
      return {
        id: executionId,
        flowName,
        status: 'pending',
      };
    },
    async resume(executionId, signal) {
      if (pending.has(executionId)) {
        return;
      }
      return flows.resume(executionId, signal);
    },
    async cancel(executionId) {
      if (pending.has(executionId)) {
        pending.delete(executionId);
        return;
      }
      return flows.cancel(executionId);
    },
    async status(executionId) {
      const pendingMeta = pending.get(executionId);
      if (pendingMeta) {
        return {
          id: executionId,
          flowName: pendingMeta.flowName,
          status: 'pending',
        };
      }
      return flows.status(executionId);
    },
    heartbeat: () => flows.heartbeat(),
  };
}
