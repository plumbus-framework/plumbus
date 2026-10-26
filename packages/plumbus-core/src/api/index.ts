// ── API Module ──
// HTTP route generation: registers Fastify routes for capabilities.
// Maps a capability to its HTTP method: the declared `api.method` where there is one,
// otherwise the kind's default (query→GET, action/job→POST).
//
// Key exports: registerAllRoutes, registerCapabilityRoute, isApiExposed

export { capabilityHttpMethod, isApiExposed } from './exposure.js';
export {
  authenticationFailureToHttp,
  buildAuthenticationRequest,
} from './authentication-http.js';
export { parseCookieHeader } from './cookies.js';
export {
  LOCALE_COOKIE_NAME,
  registerAllRoutes,
  registerCapabilityRoute,
  registerStreamingRoute,
  resolveRequestLocale,
} from './route-generator.js';
export type {
  DependencyOptions,
  ResolveRequestLocaleOptions,
  RouteGeneratorConfig,
} from './route-generator.js';
export {
  buildIdempotencyStoreKey,
  createInMemoryIdempotencyStore,
  hashPayload,
  IdempotencyAbortedError,
  isAnonymousIdempotencyPrincipal,
  MAX_PAYLOAD_DEPTH,
  parseIdempotencyTtl,
  PayloadTooDeepError,
  principalsMatch,
} from './idempotency.js';
export {
  createDatabaseIdempotencyStore,
  IdempotencyClaimLostError,
  REQUEST_IDEMPOTENCY_TABLE,
  requestIdempotencyDdl,
  sweepExpiredIdempotencyRecords,
} from './database-idempotency-store.js';
export type {
  DatabaseIdempotencyStoreOptions,
  IdempotencySweepOptions,
} from './database-idempotency-store.js';
export { executeIdempotently } from './idempotent-execution.js';
export type {
  ExecuteIdempotentlyParams,
  IdempotentExecutionOutcome,
} from './idempotent-execution.js';
export type {
  IdempotencyClaimResult,
  IdempotencyPrincipal,
  IdempotencyRecord,
  IdempotencyStore,
  IdempotencyStoreOptions,
} from './idempotency.js';
