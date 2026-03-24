import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthAdapter } from '../auth/adapter.js';
import { errorToHttpResponse } from '../errors/http.js';
import type { EventQueue } from '../events/queue.js';
import { executeCapability } from '../execution/capability-executor.js';
import type { ContextDependencies } from '../execution/context-factory.js';
import { createExecutionContext } from '../execution/context-factory.js';
import type { CapabilityContract } from '../types/capability.js';
import type { ExecutionContext } from '../types/context.js';

export interface DependencyOptions {
  /** When true, repositories skip tenant-scope filtering (for cross-tenant admin access) */
  bypassTenantScope?: boolean;
}

export interface RouteGeneratorConfig {
  /** Auth adapter for extracting identity from requests */
  authAdapter: AuthAdapter;
  /** Factory to build base context dependencies for each request */
  createDependencies: (
    auth: NonNullable<Awaited<ReturnType<AuthAdapter['authenticate']>>>,
    options?: DependencyOptions,
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
  if (capability.kind === 'eventHandler') return;

  const method = capability.kind === 'query' ? 'GET' : 'POST';
  const path = `/api/${capability.domain}/${toKebabCase(capability.name)}`;

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // 1. Authenticate
    const authHeader = request.headers.authorization;
    const auth = await config.authAdapter.authenticate(authHeader);

    // For public capabilities, use a minimal anonymous context
    const authContext = auth ?? {
      userId: undefined,
      roles: [],
      scopes: [],
      provider: 'anonymous',
    };

    // 2. Build execution context
    const bypassTenantScope = capability.access?.tenantScoped === false;
    const deps = config.createDependencies(authContext as any, { bypassTenantScope });
    deps.request = {
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'],
    };
    const ctx: ExecutionContext = createExecutionContext(deps);

    // 3. Extract input (query params for GET, body for POST)
    const input = method === 'GET' ? request.query : request.body;

    // 4. Execute capability (jobs dispatched async via queue if available)
    if (capability.kind === 'job' && config.jobQueue) {
      const jobId = crypto.randomUUID();
      await config.jobQueue.publish({
        id: jobId,
        eventType: `job.${capability.domain}.${capability.name}`,
        version: '1',
        occurredAt: new Date(),
        actor: ctx.auth.userId ?? 'anonymous',
        tenantId: ctx.auth.tenantId,
        correlationId: jobId,
        payload: input as Record<string, unknown>,
      });
      reply.status(202).send({ data: { jobId, status: 'accepted' } });
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

  if (method === 'GET') {
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

/**
 * Register a streaming SSE endpoint for a capability.
 * The callback receives an ExecutionContext and input, and should yield AIStreamEvents
 * via ctx.ai.streamGenerate(). Events are forwarded to the client as SSE.
 *
 * Path: POST /api/{domain}/{capability-name}/stream
 */
export function registerStreamingRoute(
  app: FastifyInstance,
  capability: CapabilityContract,
  config: RouteGeneratorConfig,
  streamHandler: (
    ctx: ExecutionContext,
    input: Record<string, unknown>,
  ) => AsyncIterable<import('../types/context.js').AIStreamEvent>,
): void {
  const path = `/api/${capability.domain}/${toKebabCase(capability.name)}/stream`;

  app.post(path, async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Authenticate
    const authHeader = request.headers.authorization;
    const auth = await config.authAdapter.authenticate(authHeader);
    const authContext = auth ?? {
      userId: undefined,
      roles: [],
      scopes: [],
      provider: 'anonymous',
    };

    // 2. Build context
    const bypassTenantScope = capability.access?.tenantScoped === false;
    const deps = config.createDependencies(authContext as any, { bypassTenantScope });
    deps.request = {
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'],
    };
    const ctx: ExecutionContext = createExecutionContext(deps);

    // 3. Extract input
    const input = (request.body ?? {}) as Record<string, unknown>;

    // 4. Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      for await (const event of streamHandler(ctx, input)) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
    }

    reply.raw.end();
  });
}

function toKebabCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
}
