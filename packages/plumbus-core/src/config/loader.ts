// ── Multi-Environment Config Loader ──
// Loads PlumbusConfig from environment variables with defaults per environment.
// Secrets from env vars (never hardcoded in source).

import type {
  AIProviderConfig,
  AuthAdapterConfig,
  DatabaseConfig,
  Environment,
  PlumbusConfig,
  QueueConfig,
} from '../types/config.js';

// ── Config Loader ──

export interface ConfigLoadOptions {
  /** Override environment (default: from PLUMBUS_ENV or NODE_ENV) */
  environment?: Environment;
  /** Custom env source (default: process.env) */
  env?: Record<string, string | undefined>;
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
    ai: loadAIConfig(env),
    auth: loadAuthConfig(env, environment),
    complianceProfiles: loadComplianceProfiles(env),
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
    host: env.DATABASE_HOST ?? env.PGHOST ?? defaults.host,
    port: parseInt(env.DATABASE_PORT ?? env.PGPORT ?? String(defaults.port), 10),
    database: env.DATABASE_NAME ?? env.PGDATABASE ?? defaults.database,
    user: env.DATABASE_USER ?? env.PGUSER ?? defaults.user,
    password: env.DATABASE_PASSWORD ?? env.PGPASSWORD ?? defaults.password,
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
  };
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
    secret: env.AUTH_SECRET ?? (environment === 'development' ? 'development-secret' : undefined),
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
  if (config.environment === 'production' && config.auth.secret === 'development-secret') {
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
