/**
 * The idempotency store lives in `@plumbus/core` since the core `/api` runtime surface enforces
 * the same `api.idempotency` declaration the partner surface does; this module re-exports it so
 * the partner runtime and its callers keep their import paths.
 */
export {
  buildIdempotencyStoreKey,
  createInMemoryIdempotencyStore,
  DEFAULT_IN_MEMORY_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_IN_MEMORY_IDEMPOTENCY_TTL_MS,
  hashPayload,
  IdempotencyAbortedError,
  isAnonymousIdempotencyPrincipal,
  MAX_PAYLOAD_DEPTH,
  parseIdempotencyTtl,
  PayloadTooDeepError,
  principalsMatch,
} from '@plumbus/core';
export type {
  IdempotencyClaimResult,
  IdempotencyPrincipal,
  IdempotencyRecord,
  IdempotencyStore,
  IdempotencyStoreOptions,
  InMemoryIdempotencyStoreOptions,
} from '@plumbus/core';
