import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AuthContext } from '@plumbus/core';
import { buildMcpManifest } from '@plumbus/core/mcp';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { McpServerConfig } from '../types.js';

export interface RegisterMcpOnFastifyOptions {
  /** MCP Streamable HTTP path (default `/mcp`) */
  path?: string;
  /** Discovery document path (default `/mcp/discovery`) */
  discoveryPath?: string;
  /**
   * Use stateless Streamable HTTP (default true). Stateless mode serves every
   * request with a fresh server + transport. Stateful mode (`false`) creates one
   * server + transport per session on `initialize` and binds the session to the
   * authenticated user + tenant.
   */
  stateless?: boolean;
  /**
   * Require a valid Bearer token on the discovery route.
   * Default `false` — discovery is unauthenticated so agents can self-onboard.
   * Set `true` when the tool surface itself is sensitive.
   */
  requireDiscoveryAuth?: boolean;
  /**
   * Upper bound, in bytes, on a request body sent to the MCP path. When set it is
   * applied as the Fastify route `bodyLimit` (413 above it) and as the SDK
   * transport's `maxRequestBodySize`. When omitted the Fastify instance's
   * `bodyLimit` applies (Fastify default 1 MiB).
   */
  maxRequestBodySize?: number;
  /**
   * Stateful mode only: close a session after this many ms with no request or
   * stream open; the client then gets `404 Session not found` and re-initializes.
   * Default 30 minutes (`1_800_000`, since 0.8) so abandoned sessions are released.
   * `0` or `Infinity` disables it — sessions then live until the client sends
   * DELETE or the app closes.
   */
  sessionIdleTimeoutMs?: number;
}

/** Default idle timeout for stateful MCP sessions: 30 minutes. */
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolve `sessionIdleTimeoutMs` to the timer delay, or `undefined` for no idle expiry.
 * Unset → 30 minutes; `0` / `Infinity` → disabled; negative or NaN → RangeError.
 * @internal exported for tests
 */
export function resolveSessionIdleTimeoutMs(value: number | undefined): number | undefined {
  const requested = value ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  if (Number.isNaN(requested) || requested < 0) {
    throw new RangeError(
      `sessionIdleTimeoutMs must be a positive number of ms, or 0 / Infinity to disable it, got ${String(requested)}`,
    );
  }
  return requested === 0 || requested === Number.POSITIVE_INFINITY ? undefined : requested;
}

interface McpHttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  principal: string;
  inFlight: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Sessions are bound to the authenticated user + tenant that initialized them. */
function principalKey(auth: AuthContext): string {
  return JSON.stringify([auth.userId ?? null, auth.tenantId ?? null]);
}

function sendJsonRpcError(
  reply: FastifyReply,
  status: number,
  code: number,
  message: string,
): FastifyReply {
  return reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function isInitializeBody(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
}

/**
 * Mount MCP Streamable HTTP transport and discovery route on a Fastify app.
 *
 * Requests are served by a fresh server + transport per request (stateless) or
 * per session (stateful). The returned `server` / `transport` pair is not
 * connected to any client; it is kept for API compatibility and closed with the
 * Fastify app.
 */
export async function registerMcpOnFastify(
  app: FastifyInstance,
  config: McpServerConfig,
  mcpOptions: RegisterMcpOnFastifyOptions = {},
): Promise<{ server: Server; transport: StreamableHTTPServerTransport }> {
  const { createMcpServer, releaseMcpSessionTasks } = await import('../server.js');
  const path = mcpOptions.path ?? '/mcp';
  const discoveryPath = mcpOptions.discoveryPath ?? '/mcp/discovery';
  const stateless = mcpOptions.stateless ?? true;
  const requireDiscoveryAuth = mcpOptions.requireDiscoveryAuth ?? false;
  const maxRequestBodySize = mcpOptions.maxRequestBodySize;
  if (
    maxRequestBodySize !== undefined &&
    !(Number.isFinite(maxRequestBodySize) && maxRequestBodySize > 0)
  ) {
    throw new RangeError(
      `maxRequestBodySize must be a positive number of bytes, got ${String(maxRequestBodySize)}`,
    );
  }

  // Validates the config eagerly (e.g. maxToolInputElements) and keeps the
  // historical `{ server, transport }` return shape.
  const compatServer = createMcpServer(config);
  const compatTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize,
  });
  await compatServer.connect(compatTransport);

  // `undefined` means no idle expiry (`0` / `Infinity`).
  const sessionIdleTimeoutMs = resolveSessionIdleTimeoutMs(mcpOptions.sessionIdleTimeoutMs);

  const sessions = new Map<string, McpHttpSession>();

  const armIdleTimer = (session: McpHttpSession): void => {
    if (sessionIdleTimeoutMs === undefined || session.inFlight > 0) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void session.transport.close().catch(() => {});
    }, sessionIdleTimeoutMs);
    session.idleTimer.unref?.();
  };

  /** Track a request against its session so idle expiry never cuts an open stream. */
  const trackRequest = (session: McpHttpSession, reply: FastifyReply): void => {
    if (sessionIdleTimeoutMs === undefined) return;
    session.inFlight++;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    reply.raw.once('close', () => {
      session.inFlight--;
      armIdleTimer(session);
    });
  };

  // preClose: open SSE streams would otherwise keep `app.close()` waiting.
  app.addHook('preClose', async () => {
    const open = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(open.map((s) => s.transport.close()));
    await compatServer.close().catch(() => {});
  });

  const routeOptions = maxRequestBodySize !== undefined ? { bodyLimit: maxRequestBodySize } : {};

  app.all(path, routeOptions, async (request, reply) => {
    const header =
      typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
    // Transport authentication runs before handing ownership of the socket to the SDK.
    let auth: AuthContext | null = null;
    try {
      auth = header ? await config.authAdapter.authenticate(header) : null;
    } catch {
      /* fail closed */
    }
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });

    if (stateless) {
      // The SDK refuses to reuse a stateless transport: one server + transport per request.
      const server = createMcpServer(config);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        maxRequestBodySize,
      });
      reply.raw.on('close', () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      // Tell Fastify we're taking over the response; the MCP transport
      // writes directly to reply.raw and will end the response itself.
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    const sessionHeader = request.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      // A session held by another principal reads exactly like an unknown session.
      if (!session || session.principal !== principalKey(auth)) {
        return sendJsonRpcError(reply, 404, -32001, 'Session not found');
      }
      trackRequest(session, reply);
      reply.hijack();
      await session.transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    if (request.method !== 'POST' || !isInitializeBody(request.body)) {
      return sendJsonRpcError(reply, 400, -32000, 'Bad Request: No valid session ID provided');
    }

    const principal = principalKey(auth);
    const server = createMcpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      maxRequestBodySize,
      onsessioninitialized: (id) => {
        const session: McpHttpSession = { transport, server, principal, inFlight: 0 };
        sessions.set(id, session);
        trackRequest(session, reply);
      },
    });
    transport.onclose = () => {
      void server.close().catch(() => {});
      const id = transport.sessionId;
      if (!id) return;
      const session = sessions.get(id);
      if (session?.transport === transport) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        sessions.delete(id);
      }
      releaseMcpSessionTasks(id);
    };
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  app.get(discoveryPath, async (request, reply) => {
    if (requireDiscoveryAuth) {
      const authHeader =
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined;
      const auth = await config.authAdapter.authenticate(authHeader);
      if (!auth) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }
    }
    const manifest = buildMcpManifest(config.registry);
    await reply.send({
      manifest,
      auth: {
        tokenHeader: 'Authorization',
        tokenScheme: 'Bearer',
      },
    });
  });

  return { server: compatServer, transport: compatTransport };
}

export interface StartHttpServerOptions {
  config: McpServerConfig;
  port: number;
  host?: string;
  mcpPath?: string;
  /** Forwarded to `registerMcpOnFastify` — see `RegisterMcpOnFastifyOptions.maxRequestBodySize`. */
  maxRequestBodySize?: number;
}

/** Standalone Fastify server exposing MCP over Streamable HTTP. */
export async function startHttpServer(options: StartHttpServerOptions): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
}> {
  if (options.port == null) {
    throw new Error('startHttpServer({ port }) is required. No default listen port is assumed.');
  }
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ logger: false });
  await registerMcpOnFastify(app, options.config, {
    path: options.mcpPath,
    maxRequestBodySize: options.maxRequestBodySize,
  });

  const host = options.host ?? '0.0.0.0';
  const port = options.port;
  await app.listen({ host, port });

  return {
    app,
    close: async () => {
      await app.close();
    },
  };
}
