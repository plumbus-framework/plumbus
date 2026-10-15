// ── Multi-Environment Config Loader ──
// Loads PlumbusConfig from environment variables with defaults per environment.
// Secrets from env vars (never hardcoded in source).

import { mergeConfig, parseConfigOverrides, type ConfigOverrides } from './overrides.js';
import { isValidJwtSecret } from '../auth/index.js';
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
import type { AICacheConfig, AIPromptCacheOption } from '../ai/provider.js';
import type { AISecurityConfig } from '../ai/security.js';
import { FieldClassification } from '../types/enums.js';
import type { FieldClassification as FieldClassificationType } from '../types/enums.js';

// ── Config Loader ──

export interface ConfigLoadOptions extends ConfigOverrides {
  /** Override environment (default: from PLUMBUS_ENV or NODE_ENV) */
  environment?: Environment;
  /** Custom env source (default: process.env) */
  env?: Record<string, string | undefined>;
}

/** Load PlumbusConfig from environment variables */
export function loadConfig(options?: ConfigLoadOptions): PlumbusConfig {
  const { env, ...overrides } = options ?? {};
  const config = mergeConfig(
    loadEnvironmentConfig({ env, environment: options?.environment }),
    parseConfigOverrides(overrides),
  );
  parseConfigOverrides({ environment: config.environment, queue: config.queue });
  return config;
}

export function loadEnvironmentConfig(
  options?: Pick<ConfigLoadOptions, 'env' | 'environment'>,
): PlumbusConfig {
  const env = options?.env ?? process.env;

  const environment = (options?.environment ??
    env.PLUMBUS_ENV ??
    (env.NODE_ENV === 'test' ? 'development' : env.NODE_ENV) ??
    'development') as Environment;

  return {
    environment,
    database: loadDatabaseConfig(env, environment),
    queue: loadQueueConfig(env, environment),
    execution: loadExecutionConfig(env),
    ...(env.PLUMBUS_ENABLE_SCHEDULER !== undefined
      ? { workers: { enableScheduler: env.PLUMBUS_ENABLE_SCHEDULER !== 'false' } }
      : {}),
    ai: loadAIConfig(env),
    aiProviders: loadMultiProviderConfig(env),
    auth: loadAuthConfig(env),
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

/** `database.poolSize` when `DATABASE_POOL_SIZE` is unset: postgres.js's own default. */
export const DEFAULT_DATABASE_POOL_SIZE = 10;

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
    // TLS to Postgres: on in production unless DATABASE_SSL=false says the server has none
    // (validateConfig then warns); elsewhere only with DATABASE_SSL=true.
    ssl:
      env.DATABASE_SSL === 'true' || (environment === 'production' && env.DATABASE_SSL !== 'false'),
    // Maximum connections in the process's main postgres.js pool. Unset keeps the driver's
    // default of 10, which every process used before the setting was applied.
    poolSize: parseInt(env.DATABASE_POOL_SIZE ?? String(DEFAULT_DATABASE_POOL_SIZE), 10),
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
    url: env.QUEUE_URL ?? env.REDIS_URL,
    backend: env.QUEUE_BACKEND as QueueConfig['backend'],
    ...(env.QUEUE_VISIBILITY_TIMEOUT_SEC
      ? { visibilityTimeoutSec: Number(env.QUEUE_VISIBILITY_TIMEOUT_SEC) }
      : {}),
    ...(env.QUEUE_POLL_INTERVAL_MS ? { pollIntervalMs: Number(env.QUEUE_POLL_INTERVAL_MS) } : {}),
    ...(env.QUEUE_RECLAIM_INTERVAL_MS
      ? { reclaimIntervalMs: Number(env.QUEUE_RECLAIM_INTERVAL_MS) }
      : {}),
    ...(env.QUEUE_STARTUP_TIMEOUT_MS
      ? { startupTimeoutMs: Number(env.QUEUE_STARTUP_TIMEOUT_MS) }
      : {}),
    ...(env.QUEUE_OPERATION_TIMEOUT_MS
      ? { operationTimeoutMs: Number(env.QUEUE_OPERATION_TIMEOUT_MS) }
      : {}),
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
    ...readProviderLimits(env, 'AI_'),
    cache: loadPromptCacheConfig(env),
  };
}

/**
 * The numeric limits of one provider slot, from `{prefix}MAX_TOKENS`, `{prefix}DAILY_COST_LIMIT`
 * and `{prefix}REQUEST_TIMEOUT`. Throws naming the variable when one is not a plain number in
 * range; a blank one is unset.
 */
function readProviderLimits(
  env: Record<string, string | undefined>,
  prefix: string,
): Pick<AIProviderConfig, 'maxTokensPerRequest' | 'dailyCostLimit' | 'requestTimeout'> {
  return {
    maxTokensPerRequest: readEnvNumber(env, `${prefix}MAX_TOKENS`, PROVIDER_MAX_TOKENS_RULE),
    dailyCostLimit: readEnvNumber(env, `${prefix}DAILY_COST_LIMIT`, PROVIDER_DAILY_COST_LIMIT_RULE),
    requestTimeout: readEnvNumber(env, `${prefix}REQUEST_TIMEOUT`, PROVIDER_REQUEST_TIMEOUT_RULE),
  };
}

const PROMPT_CACHE_SECTIONS = ['system', 'tools', 'messages'] as const;

/**
 * Parse `AI_PROMPT_CACHE`: `true` / `1` (system + tools), `false` / `0`, or a
 * comma-separated list of sections such as `system,messages`.
 */
function loadPromptCacheConfig(
  env: Record<string, string | undefined>,
): AIPromptCacheOption | undefined {
  const raw = env.AI_PROMPT_CACHE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  const cache: AICacheConfig = {};
  for (const section of raw.split(',').map((s) => s.trim())) {
    if (!(PROMPT_CACHE_SECTIONS as readonly string[]).includes(section)) {
      console.warn(
        `[plumbus] Invalid AI_PROMPT_CACHE="${raw}" — expected true, false, or a comma-separated list of ${PROMPT_CACHE_SECTIONS.join(', ')}; prompt caching stays off`,
      );
      return undefined;
    }
    cache[section as keyof AICacheConfig] = true;
  }
  return cache;
}

// ── Multi-Provider AI Config ──

const SUPPORTED_AI_PROVIDERS = ['openai', 'anthropic', 'bedrock'] as const;

type SupportedAiProvider = (typeof SUPPORTED_AI_PROVIDERS)[number];

function isSupportedAiProvider(name: string): name is SupportedAiProvider {
  return (SUPPORTED_AI_PROVIDERS as readonly string[]).includes(name);
}

function readOpenAiOrAnthropicConfig(
  env: Record<string, string | undefined>,
  name: 'openai' | 'anthropic',
): AIProviderConfig | undefined {
  const prefix = `AI_${name.toUpperCase()}_`;
  const apiKey = env[`${prefix}API_KEY`];
  // An empty key is a placeholder line, not a configured provider — building a
  // slot from it would fail createProviderAdapter's boot-time key validation.
  if (apiKey == null || apiKey.trim() === '') {
    return undefined;
  }

  return {
    provider: name,
    apiKey,
    model: env[`${prefix}MODEL`] ?? undefined,
    baseUrl: env[`${prefix}BASE_URL`] ?? undefined,
    ...readProviderLimits(env, prefix),
  };
}

function readBedrockConfig(env: Record<string, string | undefined>): AIProviderConfig | undefined {
  const region =
    env.AI_BEDROCK_REGION ??
    (env.AI_BEDROCK_ENABLED === '1' || env.AI_BEDROCK_ENABLED === 'true'
      ? (env.AWS_REGION ?? env.AWS_DEFAULT_REGION)
      : undefined);
  if (region == null || region === '') {
    return undefined;
  }

  return {
    provider: 'bedrock',
    // Bedrock authenticates through the AWS credential chain (IAM / IRSA /
    // instance role), never an API key. The slot carries an empty string so
    // that `AIProviderConfig.apiKey` stays a required `string` for readers.
    apiKey: '',
    region,
    model: env.AI_BEDROCK_MODEL ?? undefined,
    embeddingModel: env.AI_BEDROCK_EMBEDDING_MODEL ?? undefined,
    pricingFilePath: env.AI_BEDROCK_PRICING_FILE ?? undefined,
    ...readProviderLimits(env, 'AI_BEDROCK_'),
    pricingCacheTtlMs: readEnvNumber(env, 'AI_BEDROCK_PRICING_TTL_MS', BEDROCK_PRICING_TTL_MS_RULE),
  };
}

function readProviderConfig(
  env: Record<string, string | undefined>,
  name: SupportedAiProvider,
): AIProviderConfig | undefined {
  if (name === 'bedrock') return readBedrockConfig(env);
  return readOpenAiOrAnthropicConfig(env, name);
}

/** Load openai + anthropic + bedrock provider slots from env. */
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

  // Warn on deprecated dynamic provider env keys (except known slots)
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
    cache: loadPromptCacheConfig(env),
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

/** The longest provider request timeout Node's timers keep (see `ModelConfig.timeoutMs`). */
const MAX_PROMPT_TIMEOUT_MS = 2_147_483_647;

/** How a numeric env setting (PROMPT_{NAME}_*, AI provider limits) is read and what it must be. */
interface EnvNumberRule {
  pattern: RegExp;
  min: number;
  max: number;
  expected: string;
}

const PROMPT_TIMEOUT_MS_RULE: EnvNumberRule = {
  pattern: /^\d+$/,
  min: 1,
  max: MAX_PROMPT_TIMEOUT_MS,
  expected: `a whole number of milliseconds from 1 to ${MAX_PROMPT_TIMEOUT_MS}`,
};

const PROMPT_MAX_TOKENS_RULE: EnvNumberRule = {
  pattern: /^\d+$/,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  expected: 'a whole number of tokens, at least 1',
};

const PROMPT_TEMPERATURE_RULE: EnvNumberRule = {
  pattern: /^(?:\d+(?:\.\d*)?|\.\d+)$/,
  min: 0,
  max: 2,
  expected: 'a number from 0 to 2',
};

/** `AI_REQUEST_TIMEOUT` / `AI_{PROVIDER}_REQUEST_TIMEOUT`: the adapter's `requestTimeout`. */
const PROVIDER_REQUEST_TIMEOUT_RULE: EnvNumberRule = PROMPT_TIMEOUT_MS_RULE;

/** `AI_MAX_TOKENS` / `AI_{PROVIDER}_MAX_TOKENS`: the per-request token guard (0 refuses all). */
const PROVIDER_MAX_TOKENS_RULE: EnvNumberRule = {
  pattern: /^\d+$/,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  expected: 'a whole number of tokens, 0 or more',
};

/** `AI_DAILY_COST_LIMIT` / `AI_{PROVIDER}_DAILY_COST_LIMIT`: US dollars a day (0 refuses all). */
const PROVIDER_DAILY_COST_LIMIT_RULE: EnvNumberRule = {
  pattern: /^(?:\d+(?:\.\d*)?|\.\d+)$/,
  min: 0,
  max: Number.MAX_VALUE,
  expected: 'a number of US dollars, 0 or more',
};

/** `AI_BEDROCK_PRICING_TTL_MS`: how long downloaded Bedrock prices are kept. */
const BEDROCK_PRICING_TTL_MS_RULE: EnvNumberRule = {
  pattern: /^\d+$/,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  expected: 'a whole number of milliseconds, 0 or more',
};

/**
 * Reads one numeric env setting. Unset or blank is no value. Anything else must be a plain
 * number (digits, and a decimal point where the rule allows one; no unit suffix) in range, or
 * loading fails naming the variable: `parseInt`/`parseFloat` turned `abc` into NaN and `15m`
 * into 15, which every later call then sent or failed on.
 */
function readEnvNumber(
  env: Record<string, string | undefined>,
  variable: string,
  rule: EnvNumberRule,
): number | undefined {
  const raw = env[variable];
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  const value = rule.pattern.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
    throw new Error(`Invalid ${variable}="${raw}": expected ${rule.expected}`);
  }
  return value;
}

/**
 * Scan for PROMPT_{NAME}_* env vars and build per-prompt model overrides. Throws when a numeric
 * one (`TEMPERATURE`, `MAX_TOKENS`, `TIMEOUT_MS`) is not a usable value, naming the variable.
 */
export function loadPromptOverrides(
  env: Record<string, string | undefined>,
): Record<string, PromptModelOverride> | undefined {
  const overrides: Record<string, PromptModelOverride> = {};

  // Scan for PROMPT_{NAME}_PROVIDER or PROMPT_{NAME}_MODEL patterns
  const promptNames = new Set<string>();
  for (const key of Object.keys(env)) {
    const match =
      /^PROMPT_([A-Z][A-Z0-9_]*)_(PROVIDER|MODEL|TEMPERATURE|MAX_TOKENS|TIMEOUT_MS)$/.exec(key);
    if (match?.[1] != null) {
      promptNames.add(match[1].toLowerCase());
    }
  }

  for (const name of promptNames) {
    const prefix = `PROMPT_${name.toUpperCase()}_`;

    overrides[name] = {
      provider: env[`${prefix}PROVIDER`] ?? undefined,
      model: env[`${prefix}MODEL`] ?? undefined,
      temperature: readEnvNumber(env, `${prefix}TEMPERATURE`, PROMPT_TEMPERATURE_RULE),
      maxTokens: readEnvNumber(env, `${prefix}MAX_TOKENS`, PROMPT_MAX_TOKENS_RULE),
      timeoutMs: readEnvNumber(env, `${prefix}TIMEOUT_MS`, PROMPT_TIMEOUT_MS_RULE),
    };
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

// ── Auth Config ──

function loadAuthConfig(env: Record<string, string | undefined>): AuthAdapterConfig {
  return {
    provider: env.AUTH_PROVIDER ?? 'jwt',
    issuer: env.AUTH_ISSUER ?? undefined,
    audience: env.AUTH_AUDIENCE ?? undefined,
    jwksUri: env.AUTH_JWKS_URI ?? undefined,
    secret: env.AUTH_SECRET ?? undefined,
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
  if (
    config.database.poolSize !== undefined &&
    (!Number.isInteger(config.database.poolSize) || config.database.poolSize < 1)
  ) {
    errors.push('database.poolSize (DATABASE_POOL_SIZE) must be a whole number of at least 1');
  }
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
    if (config.auth.provider === 'custom') {
      warnings.push(
        "auth.provider is 'custom' — the server must supply an authAdapter or authenticationRuntime",
      );
    } else {
      errors.push('auth.secret or auth.jwksUri is required in production');
    }
  }

  if (config.auth.secret != null && !isValidJwtSecret(config.auth.secret)) {
    errors.push(
      'auth.secret must be at least 32 non-padding characters and must not be a development placeholder',
    );
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
