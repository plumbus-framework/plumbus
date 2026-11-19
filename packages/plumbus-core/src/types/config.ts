import type { EventDeliveryOptions } from '../events/index.js';
import type { PolicyProfile } from './enums.js';
import type { AISecurityConfig } from '../ai/security.js';
import type { AIPromptCacheOption } from '../ai/provider.js';
import type { AIReasoningConfig, ReasoningEffort } from './prompt.js';

// ── Database Config ──
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  poolSize?: number;
  /**
   * Server-side `statement_timeout` (milliseconds) for every connection of the main pool
   * (`DATABASE_STATEMENT_TIMEOUT_MS`). Unset leaves the server's setting. Not applied to
   * `plumbus migrate`'s connections, so long DDL is never cut.
   */
  statementTimeoutMs?: number;
  /**
   * Server-side `idle_in_transaction_session_timeout` (milliseconds) for the main pool
   * (`DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`): a session that holds a transaction open and
   * idle this long is ended, releasing its locks. Unset leaves the server's setting.
   */
  idleInTransactionTimeoutMs?: number;
}

// ── Queue Config ──
export interface QueueConfig {
  host: string;
  port: number;
  password?: string;
  prefix?: string;
  /** Visibility timeout for Redis queue processing recovery (seconds, default 30). */
  visibilityTimeoutSec?: number;
  url?: string;
  backend?: 'memory' | 'redis';
  pollIntervalMs?: number;
  reclaimIntervalMs?: number;
  startupTimeoutMs?: number;
  operationTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

// ── AI Provider Config ──
export interface AIProviderConfig {
  provider: string;
  /**
   * API key for OpenAI / Anthropic.
   *
   * Providers that authenticate some other way (Bedrock uses the AWS
   * credential chain) carry an empty string here. Use
   * {@link AIProviderSlotConfig} when constructing a provider slot by hand —
   * it makes the field optional so keyless providers need no placeholder.
   */
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokensPerRequest?: number;
  dailyCostLimit?: number;
  /** Request timeout in milliseconds for AI provider calls (default: 120_000) */
  requestTimeout?: number;
  /** AWS region for Bedrock (and similar region-scoped providers). */
  region?: string;
  /** Path to a Bedrock normalized pricing JSON file (`AI_BEDROCK_PRICING_FILE`). */
  pricingFilePath?: string;
  /** Default embedding model id (Bedrock Titan, etc.). */
  embeddingModel?: string;
  /** In-memory TTL for auto-downloaded Bedrock Price List rates. */
  pricingCacheTtlMs?: number;
  /**
   * Default prompt caching (`AI_PROMPT_CACHE`) for the single-provider `ai`
   * block. Slots under `aiProviders.providers` ignore it; set `aiProviders.cache`.
   */
  cache?: AIPromptCacheOption;
}

/**
 * A provider slot as accepted by `createProviderAdapter`.
 *
 * Identical to {@link AIProviderConfig} except that `apiKey` is optional,
 * because not every provider authenticates with one — Bedrock uses the AWS
 * credential chain (IAM / IRSA / instance role). Kept separate so that reading
 * `config.ai.apiKey` still yields a `string`; only the factory input is widened.
 */
export type AIProviderSlotConfig = Omit<AIProviderConfig, 'apiKey'> & { apiKey?: string };

// ── Auth Adapter Config ──
export interface AuthAdapterConfig {
  provider: string;
  issuer?: string;
  audience?: string;
  jwksUri?: string;
  secret?: string;
}

// ── Environment ──
export type Environment = 'development' | 'staging' | 'production';

// ── Multi-Provider AI Config ──
export interface AIProvidersConfig {
  /** Which provider to use when a prompt doesn't specify ModelConfig.provider */
  defaultProvider: string;
  /** Default model to use when a prompt doesn't specify one */
  defaultModel?: string;
  /** Provider configs keyed by name (e.g. "openai", "anthropic") */
  providers: Record<string, AIProviderConfig>;
  /** Per-prompt model/provider overrides — keyed by prompt name */
  promptOverrides?: Record<string, PromptModelOverride>;
  /** AI prompt security: entity field classification scanning (default mode: redact) */
  security?: AISecurityConfig;
  /**
   * Default prompt caching (`AI_PROMPT_CACHE`): marks for Anthropic / Bedrock,
   * `key` / `ttl` for OpenAI. A per-call `cache` overrides it.
   */
  cache?: AIPromptCacheOption;
}

// ── Prompt Model Override ──
export interface PromptModelOverride {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: AIReasoningConfig;
  /** @deprecated Use `reasoning`. */
  reasoningEffort?: ReasoningEffort;
  /** Provider request timeout in ms (`PROMPT_{NAME}_TIMEOUT_MS`); see `ModelConfig.timeoutMs`. */
  timeoutMs?: number;
}

// ── MCP agent config ──
export interface McpAgentConfig {
  serviceAccountId: string;
  scopes: string[];
  tenantId?: string;
}

export interface McpConfig {
  agents?: Record<string, McpAgentConfig>;
}

// ── Execution Config ──
export interface ExecutionConfig {
  /**
   * When `false`, disables transactional outbox for all capabilities (global kill switch).
   * Default: `true` (action/eventHandler capabilities run handler + output validation in a DB transaction).
   */
  transactionalOutbox?: boolean;
  /**
   * When `false`, a `query` capability whose call succeeds writes no audit row
   * (`PLUMBUS_AUDIT_SUCCESSFUL_QUERIES=false`), unless the capability sets
   * `audit: { enabled: true }`. Failed and denied calls are always recorded; other kinds are
   * unaffected. Default: `true` (every capability call is audited).
   */
  auditSuccessfulQueries?: boolean;
  /**
   * When an action / event handler opens its transaction (`PLUMBUS_TRANSACTION_BEGIN`):
   * `'lazy'` (default) at the first thing in the handler that needs it — a `ctx.data` write,
   * an event, a flow start, a job — so a handler that never writes holds no connection, and
   * reads before the first write run on the pool outside the transaction; `'eager'` before the
   * handler runs, as earlier releases did. A capability's `transactional: 'lazy' | 'eager'`
   * overrides this for that capability.
   */
  transactionBegin?: 'lazy' | 'eager';
  /**
   * Longest wait, in milliseconds, for a pool connection when a capability opens its
   * transaction (`PLUMBUS_TRANSACTION_ACQUIRE_TIMEOUT_MS`). Past it the call fails with
   * `DataPoolAcquireTimeoutError` (HTTP 503, `Retry-After`) instead of queueing without end.
   * `0` waits without limit (earlier releases). Default: `10000`.
   */
  transactionAcquireTimeoutMs?: number;
}

// ── Data Config ──
/** How repository reads (`ctx.data.<Entity>.findMany` and friends) are bounded. */
export interface DataConfig {
  /**
   * Rows one read may return unless it passes `{ unbounded: true }`; past it the read is
   * reported or refused (see `readCeilingMode`)
   * (`PLUMBUS_READ_CEILING`). A whole number of at least 1. Default: `1000`.
   */
  readCeiling?: number;
  /**
   * What a read past the ceiling does (`PLUMBUS_READ_CEILING_MODE`): `'warn'` returns what it
   * did before and logs the read with its call site (at most once a minute per call site);
   * `'error'` bounds the read in SQL and throws `DataReadCeilingError`. Default: `'warn'`.
   */
  readCeilingMode?: 'warn' | 'error';
}

// ── Workers Config ──
export interface WorkersConfig {
  eventDelivery?: EventDeliveryOptions;
  /** Start the flow scheduler (`PLUMBUS_ENABLE_SCHEDULER=false` turns it off). Default: `true`. */
  enableScheduler?: boolean;
  /**
   * Flow executions one worker pool runs at the same time (`PLUMBUS_FLOW_CONCURRENCY`). Each
   * runner slot claims one execution and drains it on its own, so a long flow holds one slot and
   * the others keep claiming. Default: `1` (one execution at a time, as before this setting).
   */
  flowConcurrency?: number;
  /**
   * How often the outbox dispatcher polls, in milliseconds (`PLUMBUS_OUTBOX_POLL_INTERVAL_MS`).
   * Under a data-plane resolver each poll visits every listed tenant plane in turn. Default:
   * `1000`.
   */
  outboxPollIntervalMs?: number;
  /**
   * Back off tenant planes whose outbox was empty (`PLUMBUS_OUTBOX_IDLE_BACKOFF_MAX_MS`): an
   * idle plane is skipped for twice as long after each idle visit, up to this many
   * milliseconds, and polled every interval again once it has work. This is also the longest
   * an event written to an idle plane waits before dispatch. Default: `0` (no back-off).
   */
  outboxIdleBackoffMaxMs?: number;
  /**
   * How often the flow runner polls for claimable executions, in milliseconds
   * (`PLUMBUS_FLOW_POLL_INTERVAL_MS`). Default: `1000` (at least 30 000 with durable queues).
   */
  flowPollIntervalMs?: number;
  /**
   * How often the flow scheduler polls due schedules, in milliseconds
   * (`PLUMBUS_SCHEDULER_POLL_INTERVAL_MS`). Default: `60000`.
   */
  schedulerPollIntervalMs?: number;
}

// ── Plumbus Config ──
export interface PlumbusConfig {
  environment: Environment;
  database: DatabaseConfig;
  queue: QueueConfig;
  execution?: ExecutionConfig;
  data?: DataConfig;
  workers?: WorkersConfig;
  mcp?: McpConfig;
  /** Single-provider AI config (legacy) */
  ai?: AIProviderConfig;
  /** Multi-provider AI config — takes precedence over `ai` when set */
  aiProviders?: AIProvidersConfig;
  auth: AuthAdapterConfig;
  complianceProfiles?: (PolicyProfile | string)[];
}
