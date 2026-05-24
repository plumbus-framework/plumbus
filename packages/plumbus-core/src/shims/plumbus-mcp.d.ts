declare module '@plumbus/mcp' {
  import type { AuthAdapter, CapabilityRegistry } from '@plumbus/core';
  import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
  import type { AuthContext } from '@plumbus/core';
  import type { ContextDependencies } from '@plumbus/core';
  import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
  import type { FastifyInstance } from 'fastify';
  import type { McpAgentConfig } from '@plumbus/core';

  export interface McpAuthAdapterConfig {
    agents: Record<string, McpAgentConfig>;
    envToken?: string;
  }

  export function createMcpAuthAdapter(config: McpAuthAdapterConfig): AuthAdapter;

  export interface McpServerConfig {
    registry: CapabilityRegistry;
    db: PostgresJsDatabase;
    authAdapter: AuthAdapter;
    createDependencies: (
      auth: AuthContext,
      options?: { bypassTenantScope?: boolean },
    ) => ContextDependencies;
    onCapabilityError?: (info: Record<string, unknown>) => void | Promise<void>;
  }

  export function createMcpServer(
    config: McpServerConfig,
    options?: { name?: string; version?: string },
  ): Server;

  export function startStdioServer(options: { server: Server }): Promise<unknown>;

  export function startHttpServer(options: {
    config: McpServerConfig;
    port?: number;
    host?: string;
    mcpPath?: string;
  }): Promise<{ app: FastifyInstance; close: () => Promise<void> }>;
}
