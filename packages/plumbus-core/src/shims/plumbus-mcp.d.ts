// Type-only stand-in for `@plumbus/mcp`. Used via the `paths` mapping in
// plumbus-core/tsconfig.json so that `await import('@plumbus/mcp')` calls in
// our CLI typecheck against this file instead of resolving to the real
// workspace package — resolving to the real package pulls plumbus-core's own
// `dist/*.d.ts` into the input set through its `@plumbus/core` re-imports and
// triggers TS5055 on emit.
//
// Keep this in sync with @plumbus/mcp's actual public surface
// (packages/mcp/src/index.ts); out-of-sync signatures will quietly miscompile
// our CLI bridge.
//
// Relative imports below (not `@plumbus/core`) for the same reason.
import type { AuthAdapter } from '../auth/adapter.js';
import type { CapabilityRegistry } from '../execution/capability-registry.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuthContext } from '../types/security.js';
import type { ContextDependencies } from '../execution/context-factory.js';
import type { EventQueue } from '../events/queue.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { McpAgentConfig } from '../types/config.js';

// ── Auth ──────────────────────────────────────────────────────────────

export interface McpAuthAdapterConfig {
  agents: Record<string, McpAgentConfig>;
  envToken?: string;
}

export declare function createMcpAuthAdapter(config: McpAuthAdapterConfig): AuthAdapter;

export declare function parseBearerToken(authorizationHeader: string | undefined): string | null;

export declare function resolveMcpAgentToken(
  authorizationHeader: string | undefined,
  agents: Record<string, McpAgentConfig>,
  envToken?: string,
): string | null;

// ── Server ────────────────────────────────────────────────────────────

export interface McpServerConfig {
  registry: CapabilityRegistry;
  db: PostgresJsDatabase;
  authAdapter: AuthAdapter;
  createDependencies: (
    auth: AuthContext,
    options?: { bypassTenantScope?: boolean },
  ) => ContextDependencies;
  onCapabilityError?: (info: {
    capabilityName: string;
    domain: string;
    errorCode: string;
    errorMessage: string;
    metadata?: Record<string, unknown>;
    userId?: string;
    tenantId?: string;
  }) => void | Promise<void>;
  requestTimeoutMs?: number;
  jobQueue?: EventQueue;
}

export declare function createMcpJobCompletionSync(
  deps: ContextDependencies,
): (
  jobId: string,
  result: 'completed' | 'failed',
  payload?: unknown,
  error?: unknown,
) => Promise<void>;

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
}

export declare function createMcpServer(
  config: McpServerConfig,
  options?: CreateMcpServerOptions,
): Server;

// ── Transports ────────────────────────────────────────────────────────

export declare function startStdioServer(options: { server: Server }): Promise<unknown>;

export interface StartHttpServerOptions {
  config: McpServerConfig;
  port: number;
  host?: string;
  mcpPath?: string;
}

export declare function startHttpServer(
  options: StartHttpServerOptions,
): Promise<{ app: FastifyInstance; close: () => Promise<void> }>;

export interface RegisterMcpOnFastifyOptions {
  path?: string;
  discoveryPath?: string;
  stateless?: boolean;
  requireDiscoveryAuth?: boolean;
}

export declare function registerMcpOnFastify(
  app: FastifyInstance,
  config: McpServerConfig,
  mcpOptions?: RegisterMcpOnFastifyOptions,
): Promise<{ server: Server; transport: StreamableHTTPServerTransport }>;
