// ── @plumbus/api ──
// External API contract layer for Plumbus applications.

export { ApiManifestError } from './errors.js';
export { generateApiDocs } from './docs/index.js';
export {
  parseManifest,
  resolveExposure,
  validateManifest,
  validateSecurityConfig,
  type ApiManifest,
  type ApiManifestEntry,
  type ApiManifestFinding,
  type SecurityScheme,
} from './manifest/index.js';
export { diffOpenApi } from './diff/index.js';
export {
  generateOpenApi,
  parseOpenApiDocument,
  serializeOpenApiDocument,
  zodToOpenApiSchema,
  type DiffEntry,
  type OpenApiDocument,
} from './openapi/index.js';
export { validateApiContract, type ApiValidateResult } from './validate.js';
export type { ApiPolicyFinding } from './policy/index.js';
export { validatePolicy } from './policy/index.js';
export type { ApiPolicy } from './policy/types.js';
export {
  buildSuccessEnvelope,
  mapApiErrorCode,
  mapCoreError,
  mapUnknownError,
  toPlumbusErrorLike,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type ApiSuccessEnvelope,
} from './runtime/envelope.js';
export {
  createInMemoryIdempotencyStore,
  IdempotencyAbortedError,
  parseIdempotencyTtl,
  type IdempotencyStore,
} from './runtime/idempotency.js';
export {
  registerApiRoutes,
  type RegisterApiRoutesOpts,
} from './runtime/register-routes.js';
export { validateTestFixtures } from './runtime/validate-fixtures.js';
export { validatePathParams } from './manifest/path-params.js';
export { buildDefaultManifest } from './manifest/default-manifest.js';
