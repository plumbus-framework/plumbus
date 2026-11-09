import { ProviderJsonSchemaError, zodToProviderJsonSchema } from '../ai/zod-to-provider-schema.js';
import { zodToJsonSchemaObject } from '../schema/json-schema.js';
import type {
  FlowDescription,
  FlowExecution,
  FlowService,
  FlowWakeResult,
} from '../types/context.js';
import { resolveAuthRoles } from '../execution/auth-roles.js';
import { createStructuredLogger } from '../observability/metrics.js';
import { AuthRole } from '../types/enums.js';
import type { AuthContext } from '../types/security.js';
import type { createFlowEngine } from './engine.js';
import type { FlowRegistry } from './registry.js';

let warnedUncheckedEngine = false;

/**
 * Creates a FlowService that wraps the flow engine for use on ctx.flows.
 * Binds the current auth context so capability handlers can start (and wake)
 * flows without passing auth explicitly.
 *
 * When a `registry` is supplied, the service also exposes `describe(flowName)`
 * so chat/tool surfaces can bind registered flows as provider tools. Without a
 * registry `describe` still exists but always returns `undefined`.
 *
 * `resume`, `cancel`, `terminate` and `status` check the bound caller against the
 * stored execution before acting:
 * - A caller with a tenant never reaches another tenant's execution; the
 *   call fails with the same "not found" error as an unknown id.
 * - With the engine's `enforceExecutionOwnership` (the default since core
 *   0.9.0-beta.9), non-system callers may only act on executions they started
 *   (same actor, same tenant). Turned off, acting on another actor's execution
 *   in the same tenant is allowed and a one-time warning is logged.
 * - Callers with the `system` role and no tenant (worker/internal paths) are
 *   not checked.
 * - Where the ownership rule would refuse the caller (of the execution's own
 *   tenant, or without a tenant), the engine's `authorizeFlowAccess` hook (when the app supplies one) decides
 *   instead: the app's own authorization says whether this caller may act on an
 *   execution somebody else started. A refusal or a throw is "not found".
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
    operation: 'resume' | 'cancel' | 'status' | 'terminate',
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
    // Fail closed: an execution whose owner cannot be read is not acted on.
    if (!owner) throw notFound(executionId);
    if (callerTenant !== null && owner.tenantId !== null && owner.tenantId !== callerTenant) {
      throw notFound(executionId);
    }
    if (isSystem) return;
    const ownsExecution =
      owner.tenantId === callerTenant && auth.userId != null && owner.actor === auth.userId;
    if (ownsExecution) return;
    if (engine.enforceExecutionOwnership) {
      // A caller of another tenant was refused above and never reaches the app. A caller
      // without a tenant (a platform operator) does, with the execution's tenant on `owner`.
      const hook = engine.authorizeFlowAccess;
      if (typeof hook !== 'function') throw notFound(executionId);
      let verdict: Awaited<ReturnType<typeof hook>>;
      try {
        verdict = await hook({ auth, operation, executionId, flowName: owner.flowName, owner });
      } catch (error) {
        // Fail closed, and say why in the log (never to the caller: the id stays unconfirmed).
        createStructuredLogger({ component: 'flows' }).warn(
          'authorizeFlowAccess threw; the flow call is refused',
          { executionId, operation, error: error instanceof Error ? error.message : String(error) },
        );
        throw notFound(executionId);
      }
      const allowed =
        verdict === true ||
        (typeof verdict === 'object' && verdict !== null && verdict.allowed === true);
      if (allowed) return;
      throw notFound(executionId);
    }
    engine.warnOnce?.(
      'flow.service.foreign-actor',
      `ctx.flows.${operation}() acted on a flow execution started by a different actor or outside the caller's tenant. enforceExecutionOwnership is off (PLUMBUS_FLOW_ENFORCE_OWNERSHIP=false); turn it back on to allow only the starting actor.`,
      { executionId, operation },
    );
  }

  return {
    async start(
      flowName: string,
      input: unknown,
      opts?: { executionId?: string; traceparent?: string },
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

    async terminate(executionId: string): Promise<void> {
      await authorize(executionId, 'terminate');
      return engine.terminate(executionId);
    },

    async status(executionId: string): Promise<FlowExecution> {
      await authorize(executionId, 'status');
      return engine.status(executionId);
    },

    // Bound to the caller's identity, like `start`: the engine wakes only that tenant's executions.
    async wake(executionId: string): Promise<FlowWakeResult> {
      return engine.wakeTimedWait(executionId, auth);
    },

    async heartbeat(): Promise<void> {
      // No-op outside of flow step execution context.
      // The real heartbeat is injected directly on flowCtx.flows by the engine.
    },

    describe(flowName: string): FlowDescription | undefined {
      if (!registry) return undefined;
      const flow = registry.get(flowName);
      if (!flow) return undefined;

      // zod-to-json-schema's jsonSchema7 target ended with `$schema`; kept for consumers that read it.
      const inputSchema: Record<string, unknown> = {
        ...zodToJsonSchemaObject(flow.input, 'draft-07'),
        $schema: 'http://json-schema.org/draft-07/schema#',
      };

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
