import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { RequestInfo as McpRequestInfo } from '@modelcontextprotocol/sdk/types.js';
import { createExecutionContext, executeCapability, type CapabilityContract } from '@plumbus/core';
import { buildMcpManifest, isMcpExposed } from '@plumbus/core/mcp';
import type { McpServerConfig } from './types.js';

const PACKAGE_VERSION: string = (() => {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const pkg = requireFromHere('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
}

/** Case-insensitive header lookup; returns first string match or undefined. */
function getHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
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
    { name: options.name ?? 'plumbus-mcp', version: options.version ?? PACKAGE_VERSION },
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
      authInfo?: AuthInfo;
      requestInfo?: McpRequestInfo;
    };

    const headerValue = getHeaderValue(extraInfo.requestInfo?.headers, 'authorization');
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

    const bypassTenantScope = cap.access?.tenantScoped === false;
    const deps = config.createDependencies(authContext, { bypassTenantScope });

    const userAgent = getHeaderValue(extraInfo.requestInfo?.headers, 'user-agent');
    if (userAgent !== undefined) {
      deps.request = { userAgent };
    }

    const ctx = createExecutionContext(deps);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const signals: AbortSignal[] = [];
    if (extraInfo.signal) signals.push(extraInfo.signal);
    if (config.requestTimeoutMs && config.requestTimeoutMs > 0) {
      const timeoutController = new AbortController();
      timeoutId = setTimeout(() => timeoutController.abort(), config.requestTimeoutMs);
      signals.push(timeoutController.signal);
    }
    if (signals.length === 1) {
      ctx.signal = signals[0];
    } else if (signals.length > 1) {
      ctx.signal = AbortSignal.any(signals);
    }

    try {
      const result = await executeCapability(
        cap as CapabilityContract,
        ctx,
        request.params.arguments ?? {},
      );

      if (!result.success && config.onCapabilityError) {
        // IIFE so a sync throw inside the hook is caught by .catch.
        void (async () =>
          config.onCapabilityError?.({
            capabilityName: cap.name,
            domain: cap.domain,
            errorCode: result.error.code,
            errorMessage: result.error.message,
            metadata: result.error.metadata,
            userId: ctx.auth.userId,
            tenantId: ctx.auth.tenantId,
          }))().catch(() => {
          /* fire-and-forget */
        });
      }

      return capabilityResultToToolResponse(result);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  });

  return server;
}
