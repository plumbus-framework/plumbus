import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { buildMcpManifest } from '@plumbus/core/mcp';
import type { McpServerConfig } from '../types.js';

export interface RegisterMcpOnFastifyOptions {
  /** MCP Streamable HTTP path (default `/mcp`) */
  path?: string;
  /** Discovery document path (default `/mcp/discovery`) */
  discoveryPath?: string;
  /** Use stateless Streamable HTTP (default true) */
  stateless?: boolean;
  /**
   * Require a valid Bearer token on the discovery route.
   * Default `false` — discovery is unauthenticated so agents can self-onboard.
   * Set `true` when the tool surface itself is sensitive.
   */
  requireDiscoveryAuth?: boolean;
}

/**
 * Mount MCP Streamable HTTP transport and discovery route on a Fastify app.
 */
export async function registerMcpOnFastify(
  app: FastifyInstance,
  config: McpServerConfig,
  mcpOptions: RegisterMcpOnFastifyOptions = {},
): Promise<{ server: Server; transport: StreamableHTTPServerTransport }> {
  const { createMcpServer } = await import('../server.js');
  const mcpServer = createMcpServer(config);
  const path = mcpOptions.path ?? '/mcp';
  const discoveryPath = mcpOptions.discoveryPath ?? '/mcp/discovery';
  const stateless = mcpOptions.stateless ?? true;
  const requireDiscoveryAuth = mcpOptions.requireDiscoveryAuth ?? false;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: stateless ? undefined : () => randomUUID(),
  });

  await mcpServer.connect(transport);

  app.all(path, async (request, reply) => {
    // Tell Fastify we're taking over the response; the MCP transport
    // writes directly to reply.raw and will end the response itself.
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

  return { server: mcpServer, transport };
}

export interface StartHttpServerOptions {
  config: McpServerConfig;
  port?: number;
  host?: string;
  mcpPath?: string;
}

/** Standalone Fastify server exposing MCP over Streamable HTTP. */
export async function startHttpServer(options: StartHttpServerOptions): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
}> {
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ logger: false });
  await registerMcpOnFastify(app, options.config, { path: options.mcpPath });

  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? 3001;
  await app.listen({ host, port });

  return {
    app,
    close: async () => {
      await app.close();
    },
  };
}
