import { ProviderJsonSchemaError, zodToProviderJsonSchema } from '../ai/zod-to-provider-schema.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { FlowDescription, FlowExecution, FlowService } from '../types/context.js';
import { resolveAuthRoles } from '../execution/auth-roles.js';
import { createStructuredLogger } from '../observability/metrics.js';
import { AuthRole } from '../types/enums.js';
import type { AuthContext } from '../types/security.js';
import type { createFlowEngine } from './engine.js';
import type { FlowRegistry } from './registry.js';

let warnedUncheckedEngine = false;

/**
 * Creates a FlowService that wraps the flow engine for use on ctx.flows.
 * Binds the current auth context so capability handlers can start flows
 * without passing auth explicitly.
 *
 * When a `registry` is supplied, the service also exposes `describe(flowName)`
 * so chat/tool surfaces can bind registered flows as provider tools. Without a
 * registry `describe` still exists but always returns `undefined`.
 *
 * `resume`, `cancel` and `status` check the bound caller against the stored
 * execution before acting:
 * - A caller with a tenant never reaches another tenant's execution; the
 *   call fails with the same "not found" error as an unknown id.
 * - With the engine's opt-in `enforceExecutionOwnership`, non-system callers
 *   may only act on executions they started (same actor, same tenant).
 *   Without it, acting on another actor's execution is still allowed and a
 *   one-time warning is logged.
 * - Callers with the `system` role and no tenant (worker/internal paths) are
 *   not checked.
 */
export function createFlowService(
  engine: ReturnType<typeof createFlowEngine>,
  auth: AuthContext,
  registry?: FlowRegistry,
): FlowService {
  const callerTenant = auth.tenantId ?? null;
  const isSystem = resolveAuthRoles(auth).includes(AuthRole.System);

  function notFound(executionId: string): Error {
    // Same message the engine uses for an unknown id, so foreign ids are not confirmed.
    return new Error(`Flow execution "${executionId}" not found`);
  }

  async function authorize(
    executionId: string,
    operation: 'resume' | 'cancel' | 'status',
  ): Promise<void> {
    if (isSystem && callerTenant === null) return;
    if (typeof engine.getExecutionOwner !== 'function') {
      // Custom engine objects without owner lookup (pre-0.8.5 shape) cannot be
      // checked; keep the old behaviour and say so once.
      if (!warnedUncheckedEngine) {
        warnedUncheckedEngine = true;
        createStructuredLogger({ component: 'flows' }).warn(
          'createFlowService(): the flow engine has no getExecutionOwner(); ctx.flows.resume/cancel/status cannot check tenant or owner. Use createFlowEngine().',
          { operation },
        );
      }
      return;
    }
    const owner = await engine.getExecutionOwner(executionId);
    if (!owner) return; // the engine reports not-found itself
    if (callerTenant !== null && owner.tenantId !== null && owner.tenantId !== callerTenant) {
      throw notFound(executionId);
    }
    if (isSystem) return;
    const ownsExecution =
      owner.tenantId === callerTenant && auth.userId != null && owner.actor === auth.userId;
    if (ownsExecution) return;
    if (engine.enforceExecutionOwnership) throw notFound(executionId);
    engine.warnOnce?.(
      'flow.service.foreign-actor',
      `ctx.flows.${operation}() acted on a flow execution started by a different actor or outside the caller's tenant. Set enforceExecutionOwnership (or PLUMBUS_FLOW_ENFORCE_OWNERSHIP=true) to allow only the starting actor.`,
      { executionId, operation },
    );
  }

  return {
    async start(
      flowName: string,
      input: unknown,
      opts?: { executionId?: string },
    ): Promise<FlowExecution> {
      return engine.start(flowName, input, auth, opts);
    },

    async resume(executionId: string, signal?: unknown): Promise<void> {
      await authorize(executionId, 'resume');
      return engine.resume(executionId, signal);
    },

    async cancel(executionId: string): Promise<void> {
      await authorize(executionId, 'cancel');
      return engine.cancel(executionId);
    },

    async status(executionId: string): Promise<FlowExecution> {
      await authorize(executionId, 'status');
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
