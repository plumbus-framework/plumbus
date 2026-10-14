import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';
import { loadConfig, type ConfigLoadOptions } from './loader.js';
import { mergeConfig, parseConfigOverrides } from './overrides.js';
import type { PlumbusConfig } from '../types/config.js';

/** File < environment < explicit options. CLI environment remains authoritative. */
export async function loadAppConfig(
  options: ConfigLoadOptions = {},
  cwd = process.cwd(),
): Promise<PlumbusConfig> {
  const env = options.env ?? process.env;
  let file = {};
  const root =
    existsSync(resolve(cwd, 'backend/package.json')) && !existsSync(resolve(cwd, 'app'))
      ? resolve(cwd, 'backend')
      : cwd;
  for (const extension of ['ts', 'js', 'mjs']) {
    const path = resolve(root, `config/app.config.${extension}`);
    if (!existsSync(path)) continue;
    const { tsImport } = await import('tsx/esm/api');
    const module = await tsImport(pathToFileURL(path).href, import.meta.url);
    const exports = z
      .object({ config: z.unknown().optional(), default: z.unknown().optional() })
      .passthrough()
      .parse(module);
    const nested = z
      .object({
        config: z.record(z.unknown()).optional(),
        default: z.record(z.unknown()).optional(),
      })
      .passthrough()
      .safeParse(exports.default);
    const input =
      exports.config ??
      (nested.success
        ? (nested.data.config ?? nested.data.default ?? exports.default)
        : exports.default);
    if (input === undefined)
      throw new DataValidationError('App config must export config or default');
    file = parseConfigOverrides(input);
    break;
  }
  const environment =
    options.environment ??
    env.PLUMBUS_ENV ??
    (env.NODE_ENV === 'test' ? 'development' : env.NODE_ENV) ??
    (file as ConfigLoadOptions).environment ??
    'development';
  const parsedEnvironment = z.enum(['development', 'staging', 'production']).parse(environment);
  let config = mergeConfig(loadConfig({ env: {}, environment: parsedEnvironment }), file);
  const fromEnv = loadConfig({ env, environment: parsedEnvironment });
  const fieldEnv: Record<string, Record<string, string[]>> = {
    database: {
      host: ['DATABASE_HOST', 'DB_HOST', 'PGHOST'],
      port: ['DATABASE_PORT', 'DB_PORT', 'PGPORT'],
      database: ['DATABASE_NAME', 'DB_NAME', 'PGDATABASE'],
      user: ['DATABASE_USER', 'DB_USER', 'PGUSER'],
      password: ['DATABASE_PASSWORD', 'DB_PASSWORD', 'PGPASSWORD'],
      ssl: ['DATABASE_SSL'],
      poolSize: ['DATABASE_POOL_SIZE'],
    },
    queue: {
      host: ['QUEUE_HOST', 'REDIS_HOST'],
      port: ['QUEUE_PORT', 'REDIS_PORT'],
      password: ['QUEUE_PASSWORD', 'REDIS_PASSWORD'],
      prefix: ['QUEUE_PREFIX'],
      url: ['QUEUE_URL', 'REDIS_URL'],
      backend: ['QUEUE_BACKEND'],
      visibilityTimeoutSec: ['QUEUE_VISIBILITY_TIMEOUT_SEC'],
      pollIntervalMs: ['QUEUE_POLL_INTERVAL_MS'],
      reclaimIntervalMs: ['QUEUE_RECLAIM_INTERVAL_MS'],
      startupTimeoutMs: ['QUEUE_STARTUP_TIMEOUT_MS'],
      operationTimeoutMs: ['QUEUE_OPERATION_TIMEOUT_MS'],
    },
    auth: {
      provider: ['AUTH_PROVIDER'],
      issuer: ['AUTH_ISSUER'],
      audience: ['AUTH_AUDIENCE'],
      jwksUri: ['AUTH_JWKS_URI'],
      secret: ['AUTH_SECRET'],
    },
    execution: { transactionalOutbox: ['PLUMBUS_TRANSACTIONAL_OUTBOX'] },
  };
  for (const [section, fields] of Object.entries(fieldEnv)) {
    const values = (fromEnv as unknown as Record<string, Record<string, unknown>>)[section] ?? {};
    const overrides: Record<string, unknown> = {};
    for (const [field, names] of Object.entries(fields)) {
      if (names.some((name) => env[name] !== undefined)) overrides[field] = values[field];
    }
    config = mergeConfig(config, { [section]: overrides });
  }
  if (fromEnv.workers) config = mergeConfig(config, { workers: fromEnv.workers });
  if (fromEnv.ai) config = mergeConfig(config, { ai: fromEnv.ai });
  if (fromEnv.aiProviders) config = mergeConfig(config, { aiProviders: fromEnv.aiProviders });
  if (env.PLUMBUS_COMPLIANCE_PROFILES !== undefined)
    config.complianceProfiles = fromEnv.complianceProfiles;
  const { env: _env, ...explicit } = options;
  config = mergeConfig(config, parseConfigOverrides(explicit));
  config.environment = parsedEnvironment;
  parseConfigOverrides(config);
  return config;
}
