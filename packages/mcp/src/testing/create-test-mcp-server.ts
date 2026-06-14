import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  buildCapabilityRuntimeDeps,
  CapabilityRegistry,
  type AuthContext,
  type CapabilityContract,
  type ContextDependencies,
} from '@plumbus/core';
import { createTestContext, type TestContextOptions } from '@plumbus/core/testing';
import { createMcpServer } from '../server.js';
import type { McpServerConfig } from '../types.js';

export interface CreateTestMcpServerOptions extends TestContextOptions {
  /** Capabilities to register in the test server's registry. */
  capabilities: CapabilityContract<any, any>[];
  /**
   * Override the auth adapter. Default accepts any Bearer-prefixed token and
   * returns a `provider: 'mcp'` AuthContext seeded from `auth` in TestContextOptions.
   */
  authAdapter?: McpServerConfig['authAdapter'];
  onCapabilityError?: McpServerConfig['onCapabilityError'];
  onMcpToolCall?: McpServerConfig['onMcpToolCall'];
  requestTimeoutMs?: number;
}

export interface TestMcpServer {
  /** Pre-connected MCP client; call `client.callTool(...)` etc. */
  client: Client;
  /** Underlying MCP server (advanced — most tests don't need this). */
  server: Server;
  /** Disconnects client + server. */
  close: () => Promise<void>;
}

export async function createTestMcpServer(
  opts: CreateTestMcpServerOptions,
): Promise<TestMcpServer> {
  const registry = new CapabilityRegistry();
  for (const cap of opts.capabilities) registry.register(cap);

  const defaultAuth: McpServerConfig['authAdapter'] = {
    async authenticate(header) {
      if (header?.startsWith('Bearer ')) {
        const auth: AuthContext = {
          userId: opts.auth?.userId ?? 'test-user',
          roles: opts.auth?.roles ?? [],
          scopes: opts.auth?.scopes ?? [],
          tenantId: opts.auth?.tenantId,
          provider: 'mcp',
        };
        return auth;
      }
      if (opts.auth?.userId !== undefined) {
        return {
          userId: opts.auth.userId,
          roles: opts.auth?.roles ?? [],
          scopes: opts.auth?.scopes ?? [],
          tenantId: opts.auth?.tenantId,
          provider: opts.auth?.provider ?? 'mcp',
        };
      }
      return null;
    },
  };

  const sharedCtx = createTestContext(opts);
  const capRuntime = buildCapabilityRuntimeDeps(registry);

  const createDependencies = (
    auth: AuthContext,
    _options?: { bypassTenantScope?: boolean },
  ): ContextDependencies => {
    return {
      auth,
      data: sharedCtx.data,
      events: sharedCtx.events,
      flows: sharedCtx.flows,
      audit: sharedCtx.audit,
      logger: sharedCtx.logger,
      time: sharedCtx.time,
      config: sharedCtx.config,
      translations: sharedCtx.translations,
      ai: sharedCtx.ai,
      ...capRuntime,
    };
  };

  const server = createMcpServer({
    registry,
    db: {} as McpServerConfig['db'],
    authAdapter: opts.authAdapter ?? defaultAuth,
    createDependencies,
    onCapabilityError: opts.onCapabilityError,
    onMcpToolCall: opts.onMcpToolCall,
    requestTimeoutMs: opts.requestTimeoutMs,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plumbus-mcp-test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
