// ── Config Module ──
// Configuration loading and validation from app.config.ts files.
// Provides ctx.config in execution contexts.
//
// Key exports: loadConfig, validateConfig

export {
  loadConfig,
  loadMultiProviderConfig,
  loadPromptOverrides,
  validateConfig,
} from './loader.js';
export { parseDurationToMs } from './duration.js';
export type { ConfigLoadOptions, ConfigValidationResult } from './loader.js';

export { loadAppConfig } from './app-config.js';
export type { ConfigOverrides } from './overrides.js';
export { resolveRetryPolicy, retryDelay, retryPolicySchema, isPermanentFailure } from './retry.js';
export type { RetryPolicy } from './retry.js';
export { isDeferredDelivery } from './retry.js';
