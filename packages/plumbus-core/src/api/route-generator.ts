import type {
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
} from "fastify";
import type { AuthAdapter } from "../auth/adapter.js";
import { errorToHttpResponse } from "../errors/http.js";
import type { EventQueue } from "../events/queue.js";
import { executeCapability } from "../execution/capability-executor.js";
import type { ContextDependencies } from "../execution/context-factory.js";
import { createExecutionContext } from "../execution/context-factory.js";
import type { CapabilityContract } from "../types/capability.js";
import type { ExecutionContext } from "../types/context.js";

export interface RouteGeneratorConfig {
  /** Auth adapter for extracting identity from requests */
  authAdapter: AuthAdapter;
  /** Factory to build base context dependencies for each request */
  createDependencies: (
    auth: NonNullable<Awaited<ReturnType<AuthAdapter["authenticate"]>>>,
  ) => ContextDependencies;
  /** Optional queue for dispatching async job capabilities */
  jobQueue?: EventQueue;
}

/**
 * Register Fastify routes for a single capability.
 * HTTP method is derived from capability kind:
 *   query → GET, action → POST, job → POST (async), eventHandler → skipped
 */
export function registerCapabilityRoute(
  app: FastifyInstance,
  capability: CapabilityContract,
  config: RouteGeneratorConfig,
): void {
  // Event handlers are internal-only, no HTTP route
  if (capability.kind === "eventHandler") return;

  const method = capability.kind === "query" ? "GET" : "POST";
  const path = `/api/${capability.domain}/${toKebabCase(capability.name)}`;

  const handler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    // 1. Authenticate
    const authHeader = request.headers.authorization;
    const auth = await config.authAdapter.authenticate(authHeader);

    // For public capabilities, use a minimal anonymous context
    const authContext = auth ?? {
      userId: undefined,
      roles: [],
      scopes: [],
      provider: "anonymous",
    };

    // 2. Build execution context
    const deps = config.createDependencies(authContext as any);
    const ctx: ExecutionContext = createExecutionContext(deps);

    // 3. Extract input (query params for GET, body for POST)
    const input =
      method === "GET" ? request.query : request.body;

    // 4. Execute capability (jobs dispatched async via queue if available)
    if (capability.kind === "job" && config.jobQueue) {
      const jobId = crypto.randomUUID();
      await config.jobQueue.publish({
        id: jobId,
        eventType: `job.${capability.domain}.${capability.name}`,
        version: "1",
        occurredAt: new Date(),
        actor: ctx.auth.userId ?? "anonymous",
        tenantId: ctx.auth.tenantId,
        correlationId: jobId,
        payload: input as Record<string, unknown>,
      });
      reply.status(202).send({ data: { jobId, status: "accepted" } });
      return;
    }

    const result = await executeCapability(capability, ctx, input);

    if (result.success) {
      reply.status(200).send({ data: result.data });
    } else {
      const httpError = errorToHttpResponse(result.error);
      reply.status(httpError.statusCode).send(httpError.body);
    }
  };

  if (method === "GET") {
    app.get(path, handler);
  } else {
    app.post(path, handler);
  }
}

/**
 * Register routes for multiple capabilities at once.
 */
export function registerAllRoutes(
  app: FastifyInstance,
  capabilities: CapabilityContract[],
  config: RouteGeneratorConfig,
): void {
  for (const cap of capabilities) {
    registerCapabilityRoute(app, cap, config);
  }
}

function toKebabCase(str: string): string {
  return str
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
}
