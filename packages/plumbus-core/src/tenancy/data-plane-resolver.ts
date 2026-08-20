// ── Data Plane Resolver ──
// Turns an opaque tenant reference into the database handle and schema
// namespaces its work runs in. Two implementations ship here:
//
//   createSingleDataPlaneResolver — every tenant reference resolves to one
//     boot-time database. This is exactly what the server and worker bootstraps
//     do today, expressed as a resolver, so existing consumers are unaffected.
//
//   createPooledDataPlaneResolver — the host supplies how to look up a tenant's
//     placement (`describe`) and how to open a connection (`connect`); the
//     framework owns the LRU cache, generation-based revalidation, explicit
//     invalidation and fail-closed behavior on an unknown tenant.
//
// Fail-closed is the load-bearing rule: an unresolvable tenant reference throws
// and no code path substitutes another tenant's database.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { logHookError } from '../errors/hook-log.js';
import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';
import type {
  DataPlaneConnection,
  DataPlaneDescriptor,
  DataPlaneHandle,
  DataPlaneResolver,
  PooledDataPlaneResolver,
  PooledDataPlaneResolverOptions,
  SingleDataPlaneResolverOptions,
} from './types.js';

/**
 * Schema the framework's own tables resolve to when the host names none.
 * `public` reproduces today's behavior: unqualified table names under a
 * default `search_path`.
 */
export const DEFAULT_CORE_SCHEMA = 'public';

/** Prefix reported for per-package schemas when the host names none. */
export const DEFAULT_PACKAGE_SCHEMA_PREFIX = 'pkg_';

/** Default number of data planes held open by the pooled resolver. */
export const DEFAULT_DATA_PLANE_CACHE_SIZE = 32;

/**
 * How many times a resolution restarts when an `invalidate` lands while it is
 * in flight. Bounded so a pathological invalidation loop surfaces as an error
 * instead of spinning.
 */
const MAX_RESOLVE_ATTEMPTS = 3;

/** Raised when a tenant reference resolves to no data plane. Never falls back. */
export class UnknownTenantError extends PlumbusError {
  constructor(tenantRef: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.NotFound, `No data plane is registered for tenant reference "${tenantRef}"`, {
      tenantRef,
      ...metadata,
    });
    this.name = 'UnknownTenantError';
  }
}

function assertTenantRef(tenantRef: string): void {
  if (typeof tenantRef !== 'string' || tenantRef.trim() === '') {
    throw new PlumbusError(
      ErrorCode.Validation,
      'A data plane cannot be resolved without a tenant reference',
    );
  }
}

function freezeHandle(handle: DataPlaneHandle): DataPlaneHandle {
  return Object.freeze(handle);
}

function buildHandle(
  tenantRef: string,
  db: PostgresJsDatabase,
  descriptor: Pick<
    DataPlaneDescriptor<unknown>,
    'coreSchema' | 'packageSchemaPrefix' | 'generation'
  >,
): DataPlaneHandle {
  return freezeHandle({
    db,
    coreSchema: descriptor.coreSchema ?? DEFAULT_CORE_SCHEMA,
    packageSchemaPrefix: descriptor.packageSchemaPrefix ?? DEFAULT_PACKAGE_SCHEMA_PREFIX,
    tenantRef,
    ...(descriptor.generation !== undefined ? { generation: descriptor.generation } : {}),
  });
}

/**
 * Back-compat resolver: one database serves every tenant reference.
 *
 * This is today's single-database behavior expressed through the resolver
 * interface — the same `db` the caller already owns is handed back for any
 * reference, including the empty reference used by untenanted callers. Use it
 * wherever a `DataPlaneResolver` is required but routing has not been adopted.
 */
export function createSingleDataPlaneResolver(
  db: PostgresJsDatabase,
  options: SingleDataPlaneResolverOptions = {},
): DataPlaneResolver {
  return {
    async resolve(tenantRef: string): Promise<DataPlaneHandle> {
      return buildHandle(tenantRef, db, options);
    },
  };
}

interface CacheEntry {
  handle: DataPlaneHandle;
  connection: DataPlaneConnection;
  generation?: number;
  coreSchema: string;
  packageSchemaPrefix: string;
  resolvedAt: number;
}

/**
 * Caching resolver over host-supplied routing.
 *
 * The host answers two questions — where does this tenant live (`describe`) and
 * how do I open a connection to it (`connect`) — and the framework owns
 * everything else: an LRU of open data planes, deduplication of concurrent
 * resolutions, generation-based revalidation, explicit invalidation, and
 * throwing on an unknown tenant rather than falling back.
 */
export function createPooledDataPlaneResolver<TConnectionInfo = unknown>(
  options: PooledDataPlaneResolverOptions<TConnectionInfo>,
): PooledDataPlaneResolver {
  const cacheSize = options.cacheSize ?? DEFAULT_DATA_PLANE_CACHE_SIZE;
  if (!Number.isInteger(cacheSize) || cacheSize < 1) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `Data plane cacheSize must be a positive integer (received ${String(options.cacheSize)})`,
    );
  }
  const now = options.now ?? Date.now;
  const revalidateAfterMs = options.revalidateAfterMs;
  const onCloseError =
    options.onCloseError ??
    ((info: { tenantRef: string; error: unknown }) =>
      logHookError('dataPlaneConnectionClose', info.error));

  /** Insertion-ordered LRU: least recently used first. */
  const entries = new Map<string, CacheEntry>();
  /** One in-flight resolution per tenant reference. */
  const inFlight = new Map<string, Promise<DataPlaneHandle>>();
  /** Bumped by `invalidate` while a resolution for that tenant is in flight. */
  const epochs = new Map<string, number>();
  let closed = false;

  function currentEpoch(tenantRef: string): number {
    return epochs.get(tenantRef) ?? 0;
  }

  function bumpEpoch(tenantRef: string): void {
    if (inFlight.has(tenantRef)) {
      epochs.set(tenantRef, currentEpoch(tenantRef) + 1);
    }
  }

  async function closeQuietly(tenantRef: string, connection: DataPlaneConnection): Promise<void> {
    try {
      await connection.close?.();
    } catch (error) {
      onCloseError({ tenantRef, error });
    }
  }

  async function evict(tenantRef: string): Promise<void> {
    const entry = entries.get(tenantRef);
    if (!entry) return;
    entries.delete(tenantRef);
    await closeQuietly(tenantRef, entry.connection);
  }

  /** Move an entry to the most-recently-used end of the LRU. */
  function touch(tenantRef: string, entry: CacheEntry): void {
    entries.delete(tenantRef);
    entries.set(tenantRef, entry);
  }

  async function enforceCapacity(): Promise<void> {
    while (entries.size > cacheSize) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      await evict(oldest.value);
    }
  }

  function isStale(entry: CacheEntry): boolean {
    if (revalidateAfterMs === undefined) return false;
    return now() - entry.resolvedAt >= revalidateAfterMs;
  }

  async function describeChecked(tenantRef: string): Promise<DataPlaneDescriptor<TConnectionInfo>> {
    const descriptor = await options.describe(tenantRef);
    if (descriptor === undefined || descriptor === null) {
      throw new UnknownTenantError(tenantRef);
    }
    return descriptor;
  }

  /**
   * Connect against `descriptor` and cache the result. Returns `undefined` when
   * an `invalidate` landed while connecting — the fresh connection is closed
   * and the caller retries, so an invalidation is never overtaken by a
   * resolution that started before it.
   */
  async function connectAndStore(
    tenantRef: string,
    descriptor: DataPlaneDescriptor<TConnectionInfo>,
    epoch: number,
  ): Promise<DataPlaneHandle | undefined> {
    const connection = await options.connect({ tenantRef, descriptor });
    if (closed) {
      await closeQuietly(tenantRef, connection);
      throw closedError(tenantRef);
    }
    if (currentEpoch(tenantRef) !== epoch) {
      await closeQuietly(tenantRef, connection);
      return undefined;
    }
    const handle = buildHandle(tenantRef, connection.db, descriptor);
    const entry: CacheEntry = {
      handle,
      connection,
      generation: descriptor.generation,
      coreSchema: handle.coreSchema,
      packageSchemaPrefix: handle.packageSchemaPrefix,
      resolvedAt: now(),
    };
    await evict(tenantRef);
    entries.set(tenantRef, entry);
    await enforceCapacity();
    return handle;
  }

  async function load(tenantRef: string): Promise<DataPlaneHandle> {
    for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
      const epoch = currentEpoch(tenantRef);
      const descriptor = await describeChecked(tenantRef);
      const handle = await connectAndStore(tenantRef, descriptor, epoch);
      if (handle) return handle;
    }
    throw invalidationRaceError(tenantRef);
  }

  /**
   * Re-read a cached tenant's placement. The cache is read again after the
   * lookup rather than trusted from before it, so an eviction or invalidation
   * that landed meanwhile cannot be overwritten with the older placement.
   */
  async function revalidate(tenantRef: string): Promise<DataPlaneHandle> {
    for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
      const epoch = currentEpoch(tenantRef);
      let descriptor: DataPlaneDescriptor<TConnectionInfo>;
      try {
        descriptor = await describeChecked(tenantRef);
      } catch (error) {
        if (error instanceof UnknownTenantError) {
          // The tenant is gone: drop the cached data plane rather than keep
          // serving it.
          await evict(tenantRef);
        }
        throw error;
      }
      const current = entries.get(tenantRef);
      if (!current || currentEpoch(tenantRef) !== epoch) {
        // Invalidated or evicted while describing — resolve from scratch.
        const handle = await connectAndStore(tenantRef, descriptor, currentEpoch(tenantRef));
        if (handle) return handle;
        continue;
      }
      if (descriptor.generation === current.generation) {
        const coreSchema = descriptor.coreSchema ?? DEFAULT_CORE_SCHEMA;
        const packageSchemaPrefix = descriptor.packageSchemaPrefix ?? DEFAULT_PACKAGE_SCHEMA_PREFIX;
        const schemasUnchanged =
          coreSchema === current.coreSchema && packageSchemaPrefix === current.packageSchemaPrefix;
        const entry: CacheEntry = {
          ...current,
          coreSchema,
          packageSchemaPrefix,
          handle: schemasUnchanged
            ? current.handle
            : buildHandle(tenantRef, current.connection.db, descriptor),
          resolvedAt: now(),
        };
        touch(tenantRef, entry);
        return entry.handle;
      }
      // Generation moved: the cached connection points at a superseded
      // placement. Close it before connecting to the new one.
      entries.delete(tenantRef);
      await closeQuietly(tenantRef, current.connection);
      const handle = await connectAndStore(tenantRef, descriptor, epoch);
      if (handle) return handle;
    }
    throw invalidationRaceError(tenantRef);
  }

  function closedError(tenantRef: string): PlumbusError {
    return new PlumbusError(
      ErrorCode.Internal,
      'Data plane resolver is closed and cannot resolve further tenants',
      { tenantRef },
    );
  }

  function invalidationRaceError(tenantRef: string): PlumbusError {
    return new PlumbusError(
      ErrorCode.Conflict,
      `Data plane resolution for tenant reference "${tenantRef}" was invalidated ` +
        `${MAX_RESOLVE_ATTEMPTS} times while resolving`,
      { tenantRef },
    );
  }

  function start(
    tenantRef: string,
    work: () => Promise<DataPlaneHandle>,
  ): Promise<DataPlaneHandle> {
    const pending = inFlight.get(tenantRef);
    if (pending) return pending;
    const promise = work().finally(() => {
      inFlight.delete(tenantRef);
      epochs.delete(tenantRef);
    });
    inFlight.set(tenantRef, promise);
    return promise;
  }

  return {
    async resolve(tenantRef: string): Promise<DataPlaneHandle> {
      if (closed) {
        throw closedError(tenantRef);
      }
      assertTenantRef(tenantRef);

      const cached = entries.get(tenantRef);
      if (cached && !isStale(cached)) {
        touch(tenantRef, cached);
        return cached.handle;
      }
      if (cached) {
        return start(tenantRef, () => revalidate(tenantRef));
      }
      return start(tenantRef, () => load(tenantRef));
    },

    async invalidate(tenantRef: string): Promise<void> {
      assertTenantRef(tenantRef);
      bumpEpoch(tenantRef);
      await evict(tenantRef);
    },

    async invalidateAll(): Promise<void> {
      for (const tenantRef of [...entries.keys(), ...inFlight.keys()]) {
        bumpEpoch(tenantRef);
      }
      for (const tenantRef of [...entries.keys()]) {
        await evict(tenantRef);
      }
    },

    async close(): Promise<void> {
      closed = true;
      for (const tenantRef of [...inFlight.keys()]) {
        bumpEpoch(tenantRef);
      }
      for (const tenantRef of [...entries.keys()]) {
        await evict(tenantRef);
      }
    },
  };
}
