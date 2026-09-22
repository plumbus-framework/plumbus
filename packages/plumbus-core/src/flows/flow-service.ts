import { ProviderJsonSchemaError, zodToProviderJsonSchema } from '../ai/zod-to-provider-schema.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { FlowDescription, FlowExecution, FlowService } from '../types/context.js';
import type { AuthContext } from '../types/security.js';
import type { createFlowEngine } from './engine.js';
import type { FlowRegistry } from './registry.js';

/**
 * Creates a FlowService that wraps the flow engine for use on ctx.flows.
 * Binds the current auth context so capability handlers can start flows
 * without passing auth explicitly.
 *
 * When a `registry` is supplied, the service also exposes `describe(flowName)`
 * so chat/tool surfaces can bind registered flows as provider tools. Without a
 * registry `describe` still exists but always returns `undefined`.
 */
export function createFlowService(
  engine: ReturnType<typeof createFlowEngine>,
  auth: AuthContext,
  registry?: FlowRegistry,
): FlowService {
  return {
    async start(
      flowName: string,
      input: unknown,
      opts?: { executionId?: string },
    ): Promise<FlowExecution> {
      return engine.start(flowName, input, auth, opts);
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

    async heartbeat(): Promise<void> {
      // No-op outside of flow step execution context.
      // The real heartbeat is injected directly on flowCtx.flows by the engine.
    },

    describe(flowName: string): FlowDescription | undefined {
      if (!registry) return undefined;
      const flow = registry.get(flowName);
      if (!flow) return undefined;

      const inputSchema = zodToJsonSchema(flow.input, {
        $refStrategy: 'none',
        target: 'jsonSchema7',
      }) as Record<string, unknown>;

      // Provider tool parameters degrade to `undefined` when the flow input
      // schema cannot be represented as a structured-output tool schema.
      let parameters: Record<string, unknown> | undefined;
      try {
        parameters = zodToProviderJsonSchema(flow.input).schema;
      } catch (err) {
        if (err instanceof ProviderJsonSchemaError) {
          parameters = undefined;
        } else {
          throw err;
        }
      }

      return {
        name: flow.name,
        domain: flow.domain,
        description: flow.description,
        inputSchema,
        parameters,
      };
    },
  };
}
