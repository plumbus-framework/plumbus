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

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: stateless ? undefined : () => randomUUID(),
  });

  await mcpServer.connect(transport);

  app.all(path, async (request, reply) => {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  app.get(discoveryPath, async (_request, reply) => {
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
