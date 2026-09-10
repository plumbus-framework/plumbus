import type { PolicyProfile } from './enums.js';
import type { AISecurityConfig } from '../ai/security.js';
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
}

// ── Queue Config ──
export interface QueueConfig {
  host: string;
  port: number;
  password?: string;
  prefix?: string;
  /** Visibility timeout for Redis queue processing recovery (seconds, default 30). */
  visibilityTimeoutSec?: number;
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
}

// ── Plumbus Config ──
export interface PlumbusConfig {
  environment: Environment;
  database: DatabaseConfig;
  queue: QueueConfig;
  execution?: ExecutionConfig;
  mcp?: McpConfig;
  /** Single-provider AI config (legacy) */
  ai?: AIProviderConfig;
  /** Multi-provider AI config — takes precedence over `ai` when set */
  aiProviders?: AIProvidersConfig;
  auth: AuthAdapterConfig;
  complianceProfiles?: (PolicyProfile | string)[];
}
