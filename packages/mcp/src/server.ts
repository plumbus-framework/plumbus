import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createExecutionContext, executeCapability, type CapabilityContract } from '@plumbus/core';
import { buildMcpManifest, isMcpExposed } from '@plumbus/core/mcp';
import type { McpServerConfig } from './types.js';

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
}

function capabilityResultToToolResponse(result: Awaited<ReturnType<typeof executeCapability>>): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  if (result.success) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data) }],
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.error) }],
    isError: true,
  };
}

/** Create an MCP server that lists and invokes MCP-exposed capabilities. */
export function createMcpServer(
  config: McpServerConfig,
  options: CreateMcpServerOptions = {},
): Server {
  const server = new Server(
    { name: options.name ?? 'plumbus-mcp', version: options.version ?? '0.4.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const manifest = buildMcpManifest(config.registry);
    return {
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const cap = config.registry.get(toolName);
    if (!cap || !isMcpExposed(cap)) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ code: 'not_found', message: 'Tool not found' }) },
        ],
        isError: true,
      };
    }

    const extraInfo = extra as {
      signal?: AbortSignal;
      authInfo?: { token?: string };
      requestInfo?: { headers?: Record<string, string | string[] | undefined> };
    };

    const headerAuth = extraInfo.requestInfo?.headers?.authorization;
    const headerValue = typeof headerAuth === 'string' ? headerAuth : undefined;
    const rawToken = extraInfo.authInfo?.token ?? headerValue;
    const authHeader =
      rawToken && !rawToken.startsWith('Bearer ') ? `Bearer ${rawToken}` : rawToken;

    const auth = await config.authAdapter.authenticate(authHeader);
    const authContext = auth ?? {
      userId: undefined,
      roles: [],
      scopes: [],
      provider: 'anonymous',
    };

    const deps = config.createDependencies(authContext);
    const ctx = createExecutionContext(deps);
    if (extraInfo.signal) {
      ctx.signal = extraInfo.signal;
    }

    const result = await executeCapability(
      cap as CapabilityContract,
      ctx,
      request.params.arguments ?? {},
    );

    if (!result.success && config.onCapabilityError) {
      Promise.resolve(
        config.onCapabilityError({
          capabilityName: cap.name,
          domain: cap.domain,
          errorCode: result.error.code,
          errorMessage: result.error.message,
          metadata: result.error.metadata,
          userId: ctx.auth.userId,
          tenantId: ctx.auth.tenantId,
        }),
      ).catch(() => {
        /* fire-and-forget */
      });
    }

    return capabilityResultToToolResponse(result);
  });

  return server;
}
