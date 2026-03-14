import type { PolicyProfile } from './enums.js';

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
}

// ── AI Provider Config ──
export interface AIProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokensPerRequest?: number;
  dailyCostLimit?: number;
}

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
}

// ── Prompt Model Override ──
export interface PromptModelOverride {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// ── Plumbus Config ──
export interface PlumbusConfig {
  environment: Environment;
  database: DatabaseConfig;
  queue: QueueConfig;
  /** Single-provider AI config (legacy) */
  ai?: AIProviderConfig;
  /** Multi-provider AI config — takes precedence over `ai` when set */
  aiProviders?: AIProvidersConfig;
  auth: AuthAdapterConfig;
  complianceProfiles?: (PolicyProfile | string)[];
}
