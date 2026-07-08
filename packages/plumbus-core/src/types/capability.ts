import type { z } from 'zod';
import type { ExecutionContext } from './context.js';
import type { CapabilityKind } from './enums.js';
import type { AccessPolicy } from './security.js';

// ── Capability Effects ──
export interface CapabilityEffects {
  data: string[];
  events: string[];
  external: string[];
  flows?: string[];
  /** Canonical capability names this capability may invoke via ctx.capabilities.invoke */
  capabilities?: string[];
  ai: boolean;
}

// ── Capability Audit Config ──
export interface CapabilityAuditConfig {
  enabled?: boolean;
  event: string;
  includeInput?: string[];
  includeOutput?: string[];
}

// ── Capability Explanation Config ──
export interface CapabilityExplanationConfig {
  enabled?: boolean;
  summary?: string;
}

// ── Surface exposure ──
export type CapabilityExposeAs = 'mcp' | 'api';

// ── MCP exposure (agent surface) ──
export interface McpExposureConfig {
  /** Agent-facing description override for MCP manifest and skills */
  description?: string;
  /** Maps to MCP annotations.destructiveHint */
  dangerous?: boolean;
  /** Categorization hints for tool selection (manifest + skills) */
  agentTags?: readonly string[];
}

// ── API exposure (external-system surface) ──
export const ApiStability = {
  Experimental: 'experimental',
  Beta: 'beta',
  Stable: 'stable',
  Deprecated: 'deprecated',
  Internal: 'internal',
} as const;
export type ApiStability = (typeof ApiStability)[keyof typeof ApiStability];

export const ApiHttpMethod = {
  Get: 'GET',
  Post: 'POST',
  Patch: 'PATCH',
  Put: 'PUT',
  Delete: 'DELETE',
} as const;
export type ApiHttpMethod = (typeof ApiHttpMethod)[keyof typeof ApiHttpMethod];

export type ApiTestMode = 'validate-only' | 'safe-reply';

export interface ApiIdempotencyConfig {
  required: boolean;
  /** Header carrying the idempotency key. Default 'Idempotency-Key'. */
  header: string;
  /** Metadata only in v1 (no persistence). e.g. '24h'. */
  ttl?: string;
}

export interface ApiTestConfig {
  enabled: boolean;
  modes: readonly ApiTestMode[];
  defaultMode?: ApiTestMode;
  safeReply?: { fixture?: string };
}

export interface ApiDocsConfig {
  summary?: string;
  description?: string;
  tags?: readonly string[];
}

export interface ApiDeprecationConfig {
  /** ISO 8601 date string. */
  sunset?: string;
  /** Replacement operationId or capability name. */
  replacement?: string;
}

export interface ApiExposureConfig {
  operationId: string;
  method: ApiHttpMethod;
  path: string;
  stability?: ApiStability;
  auth?: { scopes?: readonly string[] };
  idempotency?: ApiIdempotencyConfig;
  test?: ApiTestConfig;
  docs?: ApiDocsConfig;
  deprecation?: ApiDeprecationConfig;
}

// ── Event Handler Trigger (optional — auto-registers consumer when present) ──
export interface EventHandlerTrigger {
  event: string;
  versionConstraint?: string;
}

// ── Capability Contract ──
export interface CapabilityContract<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  kind: CapabilityKind;
  domain: string;
  description?: string;
  tags?: string[];
  version?: string;
  owner?: string;

  input: TInput;
  output: TOutput;

  access?: AccessPolicy;
  effects: CapabilityEffects;
  audit?: CapabilityAuditConfig;
  explanation?: CapabilityExplanationConfig;
  /** Surfaces this capability is exposed on (e.g. MCP tools) */
  exposeAs?: readonly CapabilityExposeAs[];
  /** MCP-specific metadata when `exposeAs` includes `'mcp'` */
  mcp?: McpExposureConfig;
  /** API-specific metadata when `exposeAs` includes `'api'` */
  api?: ApiExposureConfig;
  /** Event subscription for kind: 'eventHandler' — optional; enables auto-registration */
  trigger?: EventHandlerTrigger;
  /**
   * When `false`, opts out of the transactional outbox for this capability.
   * Default: transactional for `action` / `eventHandler` (auto-excluded for `job` and `effects.ai: true`).
   */
  transactional?: boolean;

  handler: (ctx: ExecutionContext, input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}
