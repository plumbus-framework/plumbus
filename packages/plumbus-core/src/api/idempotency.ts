import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export interface IdempotencyPrincipal {
  userId?: string;
  tenantId?: string;
}

export interface IdempotencyRecord {
  payloadHash: string;
  result: unknown;
  principal: IdempotencyPrincipal;
  expiresAt?: number;
}

export type IdempotencyClaimResult =
  /**
   * This request holds the key. A store that fences its claims returns the claim's `token`;
   * the caller passes it back as `options.claimToken` to `complete`, `completeInTransaction`
   * and `abort`.
   */
  | { status: 'new'; token?: string }
  | { status: 'replay'; record: IdempotencyRecord }
  | { status: 'conflict'; reason: 'principal' | 'payload' }
  /** Same process: the first request is still running; `wait` settles with its outcome. */
  | { status: 'in-flight'; wait: Promise<IdempotencyRecord> }
  /**
   * Another request (possibly in another process) holds a live claim on the key: answer 409
   * with `Retry-After`. After `retryAfterSeconds` the claim either completed (replay) or its
   * lease lapsed with no completion (the request runs again).
   */
  | { status: 'in-progress'; retryAfterSeconds: number };

export interface IdempotencyStoreOptions {
  /** Entry TTL in milliseconds; applied when a request completes successfully. */
  ttlMs?: number;
  /**
   * The database the request's capability runs its transaction on (the route generator sets
   * it): a database-backed store keeps the key there, so the completion can commit with the
   * business writes. In-memory stores ignore it.
   */
  database?: PostgresJsDatabase;
  /** Whether `database` is the control plane (`'spine'`) or a tenant data plane. */
  plane?: 'spine' | 'tenant';
  /** The token of this request's claim (`{ status: 'new', token }`), for complete/abort. */
  claimToken?: string;
}

export interface IdempotencyStore {
  /** `'memory'` for a process-local store; production and staging warn when one is active. */
  readonly kind?: string;
  claim(
    key: string,
    payloadHash: string,
    principal: IdempotencyPrincipal,
    options?: IdempotencyStoreOptions,
  ): Promise<IdempotencyClaimResult>;
  complete(key: string, result: unknown, options?: IdempotencyStoreOptions): Promise<void>;
  /**
   * Record the completion inside the capability's business transaction (`tx`, on
   * `options.database`), so the business effect and the completion commit together or not at
   * all. Throws when the claim was taken over by another request, which rolls the business
   * transaction back. Optional: without it the completion is written after the capability
   * returned (`complete`).
   */
  completeInTransaction?(
    tx: PostgresJsDatabase,
    key: string,
    result: unknown,
    options?: IdempotencyStoreOptions,
  ): Promise<void>;
  abort(key: string, options?: IdempotencyStoreOptions): Promise<void>;
}

/** Thrown when an in-flight idempotency claim is aborted (e.g. the first request failed). */
export class IdempotencyAbortedError extends Error {
  constructor() {
    super('Idempotency claim aborted');
    this.name = 'IdempotencyAbortedError';
  }
}

const TTL_MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse manifest idempotency TTL strings such as `24h` or `30m` into milliseconds. */
export function parseIdempotencyTtl(ttl: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === undefined) {
    return undefined;
  }
  const multiplier = TTL_MULTIPLIERS[unit];
  if (multiplier === undefined) {
    return undefined;
  }
  return value * multiplier;
}

export function buildIdempotencyStoreKey(
  operationId: string,
  principal: IdempotencyPrincipal,
  idempotencyKey: string,
): string {
  const tenantPart = principal.tenantId ?? '';
  const userPart = principal.userId ?? '';
  return `${operationId}:${tenantPart}:${userPart}:${idempotencyKey}`;
}

export function principalsMatch(a: IdempotencyPrincipal, b: IdempotencyPrincipal): boolean {
  return a.userId === b.userId && a.tenantId === b.tenantId;
}

/** True when neither userId nor tenantId is set (anonymous `::` principal). */
export function isAnonymousIdempotencyPrincipal(principal: IdempotencyPrincipal): boolean {
  return principal.userId === undefined && principal.tenantId === undefined;
}

type InFlightEntry = {
  payloadHash: string;
  principal: IdempotencyPrincipal;
  promise: Promise<IdempotencyRecord>;
  resolve: (record: IdempotencyRecord) => void;
  reject: (error: Error) => void;
};

/**
 * How deep a payload may nest before fingerprinting refuses it.
 *
 * `canonicalize` recurses once per level, and a body that nests tens of thousands of levels
 * (JSON.parse accepts it) took the whole request handler down with a `RangeError` — an
 * unhandled 500 from a tiny payload. No real input comes close to this depth; a payload past
 * it is refused as malformed rather than hashed.
 */
export const MAX_PAYLOAD_DEPTH = 64;

/** Thrown by {@link hashPayload} when a payload nests deeper than {@link MAX_PAYLOAD_DEPTH}. */
export class PayloadTooDeepError extends Error {
  constructor() {
    super(`Payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`);
    this.name = 'PayloadTooDeepError';
  }
}

function canonicalize(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_PAYLOAD_DEPTH) {
    throw new PayloadTooDeepError();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const sorted = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of sorted) {
    result[key] = canonicalize(obj[key], depth + 1);
  }
  return result;
}

/**
 * Stable JSON serialization for idempotency payload hashing (sorted object keys).
 *
 * Throws {@link PayloadTooDeepError} for a payload nested past {@link MAX_PAYLOAD_DEPTH}; a
 * route answers that as a `validation` refusal, never as an unhandled error.
 */
export function hashPayload(payload: unknown): string {
  return JSON.stringify(canonicalize(payload, 0));
}

function isExpired(record: IdempotencyRecord): boolean {
  return record.expiresAt !== undefined && Date.now() > record.expiresAt;
}

function replayOrConflict(
  record: IdempotencyRecord,
  payloadHash: string,
  principal: IdempotencyPrincipal,
): IdempotencyClaimResult {
  if (!principalsMatch(record.principal, principal)) {
    return { status: 'conflict', reason: 'principal' };
  }
  if (record.payloadHash !== payloadHash) {
    return { status: 'conflict', reason: 'payload' };
  }
  return { status: 'replay', record };
}

function createInFlightEntry(payloadHash: string, principal: IdempotencyPrincipal): InFlightEntry {
  let resolve: (record: IdempotencyRecord) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<IdempotencyRecord>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void promise.catch(() => {
    /* absorb early abort before a route handler attaches its own catch */
  });
  return { payloadHash, principal, promise, resolve, reject };
}

function pruneExpiredEntries(store: Map<string, InFlightEntry | IdempotencyRecord>): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if ('result' in entry && entry.expiresAt !== undefined && now > entry.expiresAt) {
      store.delete(key);
    }
  }
}

/** Evict the oldest completed records until the store holds at most `maxEntries`. */
function evictOldestRecords(
  store: Map<string, InFlightEntry | IdempotencyRecord>,
  maxEntries: number,
): void {
  if (store.size <= maxEntries) {
    return;
  }
  for (const [key, entry] of store) {
    if (store.size <= maxEntries) {
      return;
    }
    // In-flight claims are never evicted: waiters depend on them resolving.
    if ('result' in entry) {
      store.delete(key);
    }
  }
}

/** Default lifetime of a completed in-memory idempotency record (24 hours). */
export const DEFAULT_IN_MEMORY_IDEMPOTENCY_TTL_MS = 86_400_000;

/** Default maximum number of entries held by the in-memory idempotency store. */
export const DEFAULT_IN_MEMORY_IDEMPOTENCY_MAX_ENTRIES = 10_000;

export interface InMemoryIdempotencyStoreOptions {
  /**
   * TTL applied to completed records when the route gives none (manifest `idempotency.ttl`
   * wins when set). Default 24h. Pass `Number.POSITIVE_INFINITY` to keep records forever.
   */
  defaultTtlMs?: number;
  /**
   * Maximum entries kept; the oldest completed records are evicted first. In-flight claims
   * are never evicted. Default 10 000. Pass `Number.POSITIVE_INFINITY` for no bound.
   */
  maxEntries?: number;
}

/**
 * Process-local idempotency store for development, tests and single-instance deployments.
 * Completed records expire after the route TTL (or `defaultTtlMs`, 24h by default) and the
 * store is bounded by `maxEntries` (10 000 by default, oldest completed records evicted first).
 * A retry that reaches another process runs again. Use `createDatabaseIdempotencyStore`
 * wherever more than one process serves the routes.
 */
export function createInMemoryIdempotencyStore(
  storeOptions?: InMemoryIdempotencyStoreOptions,
): IdempotencyStore {
  const store = new Map<string, InFlightEntry | IdempotencyRecord>();
  const defaultTtlMs = storeOptions?.defaultTtlMs ?? DEFAULT_IN_MEMORY_IDEMPOTENCY_TTL_MS;
  const maxEntries = storeOptions?.maxEntries ?? DEFAULT_IN_MEMORY_IDEMPOTENCY_MAX_ENTRIES;

  return {
    kind: 'memory',
    async claim(key, payloadHash, principal) {
      const existing = store.get(key);
      if (existing === undefined) {
        store.set(key, createInFlightEntry(payloadHash, principal));
        evictOldestRecords(store, maxEntries);
        return { status: 'new' };
      }

      if ('result' in existing) {
        if (isExpired(existing)) {
          store.delete(key);
          store.set(key, createInFlightEntry(payloadHash, principal));
          return { status: 'new' };
        }
        return replayOrConflict(existing, payloadHash, principal);
      }

      if (!principalsMatch(existing.principal, principal)) {
        return { status: 'conflict', reason: 'principal' };
      }
      if (existing.payloadHash !== payloadHash) {
        return { status: 'conflict', reason: 'payload' };
      }
      return { status: 'in-flight', wait: existing.promise };
    },

    async complete(key, result, options) {
      const existing = store.get(key);
      if (existing === undefined || 'result' in existing) {
        return;
      }
      const ttlMs = options?.ttlMs ?? defaultTtlMs;
      const record: IdempotencyRecord = {
        payloadHash: existing.payloadHash,
        result,
        principal: existing.principal,
        expiresAt: Number.isFinite(ttlMs) ? Date.now() + ttlMs : undefined,
      };
      // Re-insert so Map order tracks completion time (oldest completed evicted first).
      store.delete(key);
      store.set(key, record);
      existing.resolve(record);
      pruneExpiredEntries(store);
      evictOldestRecords(store, maxEntries);
    },

    async abort(key) {
      const existing = store.get(key);
      if (existing !== undefined && !('result' in existing)) {
        existing.reject(new IdempotencyAbortedError());
        store.delete(key);
      }
    },
  };
}
