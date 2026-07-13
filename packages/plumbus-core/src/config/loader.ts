// ── Multi-Environment Config Loader ──
// Loads PlumbusConfig from environment variables with defaults per environment.
// Secrets from env vars (never hardcoded in source).

import { ErrorDocUrls, ErrorHints } from '../errors/hints.js';
import type {
  AIProviderConfig,
  AIProvidersConfig,
  AuthAdapterConfig,
  DatabaseConfig,
  Environment,
  ExecutionConfig,
  PlumbusConfig,
  PromptModelOverride,
  QueueConfig,
} from '../types/config.js';
import type { AISecurityConfig } from '../ai/security.js';
import { FieldClassification } from '../types/enums.js';
import type { FieldClassification as FieldClassificationType } from '../types/enums.js';

// ── Config Loader ──

export interface ConfigLoadOptions {
  /** Override environment (default: from PLUMBUS_ENV or NODE_ENV) */
  environment?: Environment;
  /** Custom env source (default: process.env) */
  env?: Record<string, string | undefined>;
  /** Allow extra passthrough config (merged into result) */
  [key: string]: unknown;
}

/** Load PlumbusConfig from environment variables */
export function loadConfig(options?: ConfigLoadOptions): PlumbusConfig {
  const env = options?.env ?? process.env;

  const environment = (options?.environment ??
    env.PLUMBUS_ENV ??
    env.NODE_ENV ??
    'development') as Environment;

  return {
    environment,
    database: loadDatabaseConfig(env, environment),
    queue: loadQueueConfig(env, environment),
    execution: loadExecutionConfig(env),
    ai: loadAIConfig(env),
    aiProviders: loadMultiProviderConfig(env),
    auth: loadAuthConfig(env, environment),
    complianceProfiles: loadComplianceProfiles(env),
  };
}

// ── Execution Config ──

function loadExecutionConfig(env: Record<string, string | undefined>): ExecutionConfig {
  const raw = env.PLUMBUS_TRANSACTIONAL_OUTBOX;
  return {
    transactionalOutbox: raw === undefined ? true : raw !== 'false',
  };
}

// ── Database Config ──

function loadDatabaseConfig(
  env: Record<string, string | undefined>,
  environment: Environment,
): DatabaseConfig {
  const defaults =
    environment === 'development'
      ? {
          host: 'localhost',
          port: 5432,
          database: 'plumbus_dev',
          user: 'postgres',
          password: 'postgres',
        }
      : { host: 'localhost', port: 5432, database: 'plumbus', user: 'plumbus', password: '' };

  return {
    host: env.DATABASE_HOST ?? env.DB_HOST ?? env.PGHOST ?? defaults.host,
    port: parseInt(env.DATABASE_PORT ?? env.DB_PORT ?? env.PGPORT ?? String(defaults.port), 10),
    database: env.DATABASE_NAME ?? env.DB_NAME ?? env.PGDATABASE ?? defaults.database,
    user: env.DATABASE_USER ?? env.DB_USER ?? env.PGUSER ?? defaults.user,
    password: env.DATABASE_PASSWORD ?? env.DB_PASSWORD ?? env.PGPASSWORD ?? defaults.password,
    ssl: env.DATABASE_SSL === 'true' || environment === 'production',
    poolSize: parseInt(env.DATABASE_POOL_SIZE ?? (environment === 'production' ? '20' : '5'), 10),
  };
}

// ── Queue Config ──

function loadQueueConfig(
  env: Record<string, string | undefined>,
  environment: Environment,
): QueueConfig {
  return {
    host: env.QUEUE_HOST ?? env.REDIS_HOST ?? 'localhost',
    port: parseInt(env.QUEUE_PORT ?? env.REDIS_PORT ?? '6379', 10),
    password: env.QUEUE_PASSWORD ?? env.REDIS_PASSWORD ?? undefined,
    prefix: env.QUEUE_PREFIX ?? `plumbus:${environment}`,
  };
}

// ── AI Config ──

function loadAIConfig(env: Record<string, string | undefined>): AIProviderConfig | undefined {
  const provider = env.AI_PROVIDER;
  const apiKey = env.AI_API_KEY;

  if (!provider || !apiKey) return undefined;

  return {
    provider,
    apiKey,
    model: env.AI_MODEL ?? undefined,
    baseUrl: env.AI_BASE_URL ?? undefined,
    maxTokensPerRequest: env.AI_MAX_TOKENS ? parseInt(env.AI_MAX_TOKENS, 10) : undefined,
    dailyCostLimit: env.AI_DAILY_COST_LIMIT ? parseFloat(env.AI_DAILY_COST_LIMIT) : undefined,
    requestTimeout: env.AI_REQUEST_TIMEOUT ? parseInt(env.AI_REQUEST_TIMEOUT, 10) : undefined,
  };
}

// ── Multi-Provider AI Config ──

const SUPPORTED_AI_PROVIDERS = ['openai', 'anthropic'] as const;

type SupportedAiProvider = (typeof SUPPORTED_AI_PROVIDERS)[number];

function isSupportedAiProvider(name: string): name is SupportedAiProvider {
  return (SUPPORTED_AI_PROVIDERS as readonly string[]).includes(name);
}

function readProviderConfig(
  env: Record<string, string | undefined>,
  name: SupportedAiProvider,
): AIProviderConfig | undefined {
  const prefix = `AI_${name.toUpperCase()}_`;
  const apiKey = env[`${prefix}API_KEY`];
  if (apiKey == null) {
    return undefined;
  }

  const maxTokensRaw = env[`${prefix}MAX_TOKENS`];
  const dailyCostRaw = env[`${prefix}DAILY_COST_LIMIT`];
  const timeoutRaw = env[`${prefix}REQUEST_TIMEOUT`];

  return {
    provider: name,
    apiKey,
    model: env[`${prefix}MODEL`] ?? undefined,
    baseUrl: env[`${prefix}BASE_URL`] ?? undefined,
    maxTokensPerRequest: maxTokensRaw != null ? parseInt(maxTokensRaw, 10) : undefined,
    dailyCostLimit: dailyCostRaw != null ? parseFloat(dailyCostRaw) : undefined,
    requestTimeout: timeoutRaw != null ? parseInt(timeoutRaw, 10) : undefined,
  };
}

/** Load openai + anthropic provider slots from env (H2). */
export function loadMultiProviderConfig(
  env: Record<string, string | undefined>,
): AIProvidersConfig | undefined {
  const defaultProvider = env.AI_DEFAULT_PROVIDER;
  if (!defaultProvider) return undefined;

  const providers: Record<string, AIProviderConfig> = {};
  for (const name of SUPPORTED_AI_PROVIDERS) {
    const config = readProviderConfig(env, name);
    if (config) {
      providers[name] = config;
    }
  }

  // Warn on deprecated dynamic provider env keys
  for (const key of Object.keys(env)) {
    const match = /^AI_([A-Z][A-Z0-9_]*)_API_KEY$/.exec(key);
    if (match?.[1] != null) {
      const name = match[1].toLowerCase();
      if (!isSupportedAiProvider(name)) {
        console.warn(
          `[plumbus] Ignoring ${key}: ${ErrorHints.aiProviderEnv} (${ErrorDocUrls.aiIntegration})`,
        );
      }
    }
  }

  if (Object.keys(providers).length === 0) return undefined;

  return {
    defaultProvider,
    defaultModel: env.AI_DEFAULT_MODEL ?? undefined,
    providers,
    promptOverrides: loadPromptOverrides(env),
    security: loadAiSecurityConfig(env),
  };
}

function parseFieldClassificationEnv(
  raw: string | undefined,
  envName: string,
): FieldClassificationType | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const values = Object.values(FieldClassification) as string[];
  if (!values.includes(trimmed)) {
    console.warn(
      `[plumbus] Invalid ${envName}="${trimmed}" — expected one of: ${values.join(', ')}`,
    );
    return undefined;
  }
  return trimmed as FieldClassificationType;
}

function loadAiSecurityConfig(
  env: Record<string, string | undefined>,
): AISecurityConfig | undefined {
  const modeRaw = env.AI_SECURITY_MODE?.trim().toLowerCase();
  const warnThreshold = parseFieldClassificationEnv(
    env.AI_SECURITY_WARN_THRESHOLD,
    'AI_SECURITY_WARN_THRESHOLD',
  );
  const redactThreshold = parseFieldClassificationEnv(
    env.AI_SECURITY_REDACT_THRESHOLD,
    'AI_SECURITY_REDACT_THRESHOLD',
  );

  if (!modeRaw && !warnThreshold && !redactThreshold) {
    return undefined;
  }

  if (modeRaw && modeRaw !== 'block' && modeRaw !== 'redact') {
    console.warn(
      `[plumbus] Invalid AI_SECURITY_MODE="${modeRaw}" — expected "block" or "redact"; defaulting to "redact"`,
    );
  }

  return {
    mode: modeRaw === 'block' ? 'block' : 'redact',
    warnThreshold,
    redactThreshold,
  };
}

// \u2500\u2500 Prompt Model Overrides \u2500\u2500

/** Scan for PROMPT_{NAME}_* env vars and build per-prompt model overrides */
export function loadPromptOverrides(
  env: Record<string, string | undefined>,
): Record<string, PromptModelOverride> | undefined {
  const overrides: Record<string, PromptModelOverride> = {};

  // Scan for PROMPT_{NAME}_PROVIDER or PROMPT_{NAME}_MODEL patterns
  const promptNames = new Set<string>();
  for (const key of Object.keys(env)) {
    const match = /^PROMPT_([A-Z][A-Z0-9_]*)_(PROVIDER|MODEL|TEMPERATURE|MAX_TOKENS)$/.exec(key);
    if (match?.[1] != null) {
      promptNames.add(match[1].toLowerCase());
    }
  }

  for (const name of promptNames) {
    const prefix = `PROMPT_${name.toUpperCase()}_`;
    const tempRaw = env[`${prefix}TEMPERATURE`];
    const maxTokensRaw = env[`${prefix}MAX_TOKENS`];

    overrides[name] = {
      provider: env[`${prefix}PROVIDER`] ?? undefined,
      model: env[`${prefix}MODEL`] ?? undefined,
      temperature: tempRaw != null ? parseFloat(tempRaw) : undefined,
      maxTokens: maxTokensRaw != null ? parseInt(maxTokensRaw, 10) : undefined,
    };
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

// ── Auth Config ──

function loadAuthConfig(
  env: Record<string, string | undefined>,
  environment: Environment,
): AuthAdapterConfig {
  return {
    provider: env.AUTH_PROVIDER ?? 'jwt',
    issuer: env.AUTH_ISSUER ?? undefined,
    audience: env.AUTH_AUDIENCE ?? undefined,
    jwksUri: env.AUTH_JWKS_URI ?? undefined,
    secret:
      env.AUTH_SECRET ??
      (environment === 'development' ? 'development-secret-placeholder-32chars-min' : undefined),
  };
}

// ── Compliance Profiles ──

function loadComplianceProfiles(env: Record<string, string | undefined>): string[] | undefined {
  const raw = env.PLUMBUS_COMPLIANCE_PROFILES;
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Config Validation ──

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate a PlumbusConfig for completeness and correctness */
export function validateConfig(config: PlumbusConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Database
  if (!config.database.host) errors.push('database.host is required');
  if (!config.database.database) errors.push('database.database is required');
  if (!config.database.user) errors.push('database.user is required');
  if (config.environment === 'production' && !config.database.password) {
    errors.push('database.password is required in production');
  }
  if (config.environment === 'production' && !config.database.ssl) {
    warnings.push('database.ssl should be enabled in production');
  }

  // Auth
  const devPlaceholderSecrets = [
    'development-secret',
    'development-secret-placeholder-32chars-min',
  ];
  if (
    config.environment === 'production' &&
    config.auth.secret != null &&
    devPlaceholderSecrets.includes(config.auth.secret)
  ) {
    errors.push('auth.secret must be changed from default in production');
  }
  if (config.environment === 'production' && !config.auth.secret && !config.auth.jwksUri) {
    errors.push('auth.secret or auth.jwksUri is required in production');
  }

  // AI (optional but validate if present)
  if (config.ai) {
    if (!config.ai.apiKey) errors.push('ai.apiKey is required when AI is configured');
    if (!config.ai.provider) errors.push('ai.provider is required when AI is configured');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
