// Resolves smoke config from the environment. Secrets stay in .env (gitignored).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const envFile = path.join(appRoot, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

/** Redact a secret for display — never log full keys. */
export function mask(secret) {
  if (!secret) return '(none)';
  if (secret.length <= 12) return '••••';
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

/**
 * The key can arrive under either name: the framework-prefixed
 * AI_TYPESAFE_API_KEY that `loadConfig()` reads, or the SDK-native
 * TYPESAFE_API_KEY. Both are accepted by the adapter, so both work here.
 */
export function resolveConfig() {
  const apiKey = optional('AI_TYPESAFE_API_KEY', optional('TYPESAFE_API_KEY', undefined));

  if (!apiKey) {
    return { configured: false };
  }

  return {
    configured: true,
    apiKey,
    model: optional('AI_DECISION_MODEL', optional('AI_TYPESAFE_MODEL', 'jev-latest')),
    baseUrl: optional('AI_TYPESAFE_BASE_URL', undefined),
    requestTimeout: Number(optional('AI_TYPESAFE_REQUEST_TIMEOUT', '30000')),
  };
}
