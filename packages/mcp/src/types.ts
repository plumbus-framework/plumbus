import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuthAdapter, CapabilityRegistry, ContextDependencies } from '@plumbus/core';
import type { AuthContext } from '@plumbus/core';

/** Mirrors RouteGeneratorConfig (packages/plumbus-core/src/api/route-generator.ts). */
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
  /**
   * Optional per-request timeout (ms). If set and exceeded, ctx.signal aborts
   * and cooperative handlers (`ctx.ai.*`, fetch, etc.) cancel. Omit for no timeout.
   */
  requestTimeoutMs?: number;
  /**
   * Optional per-tool-call observability hook. Fires after every executeCapability,
   * regardless of success/failure. Fire-and-forget — hook errors are logged to
   * stderr and never propagate to the MCP client. Mirrors `onAICostRecorded`.
   */
  onMcpToolCall?: (info: McpToolCallInfo) => void | Promise<void>;
}

export interface McpToolCallInfo {
  capabilityName: string;
  domain: string;
  durationMs: number;
  status: 'success' | 'error';
  errorCode?: string;
  userId?: string;
  tenantId?: string;
  /** ctx.auth.provider — usually 'mcp' or 'anonymous'. */
  provider: string;
}
