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
export type { ConfigLoadOptions, ConfigValidationResult } from './loader.js';
