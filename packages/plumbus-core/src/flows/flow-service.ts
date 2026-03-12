import type { FlowExecution, FlowService } from '../types/context.js';
import type { AuthContext } from '../types/security.js';
import type { createFlowEngine } from './engine.js';

/**
 * Creates a FlowService that wraps the flow engine for use on ctx.flows.
 * Binds the current auth context so capability handlers can start flows
 * without passing auth explicitly.
 */
export function createFlowService(
  engine: ReturnType<typeof createFlowEngine>,
  auth: AuthContext,
): FlowService {
  return {
    async start(flowName: string, input: unknown): Promise<FlowExecution> {
      return engine.start(flowName, input, auth);
    },

    async resume(executionId: string, signal?: unknown): Promise<void> {
      return engine.resume(executionId, signal);
    },

    async cancel(executionId: string): Promise<void> {
      return engine.cancel(executionId);
    },

    async status(executionId: string): Promise<FlowExecution> {
      return engine.status(executionId);
    },
  };
}
