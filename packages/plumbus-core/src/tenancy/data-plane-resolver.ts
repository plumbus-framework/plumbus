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
//     framework owns the bounded cache, leases (a plane in use is never closed),
//     generation-based revalidation, explicit invalidation and fail-closed
//     behavior on an unknown tenant.
//
// Fail-closed is the load-bearing rule: an unresolvable tenant reference throws
// and no code path substitutes another tenant's database.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { logHookError } from '../errors/hook-log.js';
import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';
import { createSharedConnectionBudget, type SharedConnectionBudget } from './connection-budget.js';
import type {
  DataPlaneAcquireOptions,
  DataPlaneConnection,
  DataPlaneDescriptor,
  DataPlaneHandle,
  DataPlaneLease,
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
 * Default time a resolution waits for a free connection slot when every open plane is
 * leased, before `DataPlaneCapacityError`.
 */
export const DEFAULT_DATA_PLANE_CAPACITY_WAIT_MS = 10_000;

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

/**
 * Every open data plane is leased and none was released within the wait: opening another
 * would exceed `cacheSize`, the connection budget the host sized its database for. Nothing
 * was closed or opened. Served as HTTP 503 on the request path; background loops skip the
 * plane until their next cycle.
 */
export class DataPlaneCapacityError extends PlumbusError {
  constructor(
    tenantRef: string,
    metadata: { cacheSize: number; leases: number; waitedMs: number },
  ) {
    super(
      ErrorCode.Conflict,
      `No data plane slot for tenant reference "${tenantRef}": all ${metadata.cacheSize} open ` +
        `planes are in use (${metadata.leases} leases) and none was released within ` +
        `${metadata.waitedMs} ms`,
      { tenantRef, ...metadata, reason: 'data-plane-capacity', httpStatus: 503 },
    );
    this.name = 'DataPlaneCapacityError';
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
    // One database owned by the caller: nothing to hold open, so the lease only carries it.
    async acquire(tenantRef: string): Promise<DataPlaneLease> {
      return { handle: buildHandle(tenantRef, db, options), release() {} };
    },
  };
}

interface CacheEntry {
  tenantRef: string;
  handle: DataPlaneHandle;
  connection: DataPlaneConnection;
  generation?: number;
  coreSchema: string;
  packageSchemaPrefix: string;
  resolvedAt: number;
  /** Leases held on this plane now. A plane with leases is never closed (but by `close()`). */
  leases: number;
  /** Taken out of the cache while leased; closed when its last lease is released. */
  retired: boolean;
  /** Closed (or closing): nothing may lease it any more. */
  ended: boolean;
}

/**
 * Wraps every caller of `createPooledDataPlaneResolver`: a lease when the resolver can give
 * one, else a plain `resolve` with a release that does nothing.
 */
export async function acquireDataPlane(
  resolver: DataPlaneResolver,
  tenantRef: string,
  options?: DataPlaneAcquireOptions,
): Promise<DataPlaneLease> {
  if (resolver.acquire) return resolver.acquire(tenantRef, options);
  const handle = await resolver.resolve(
    tenantRef,
    options?.purpose ? { purpose: options.purpose } : undefined,
  );
  return { handle, release() {} };
}

/**
 * Run `work` with the tenant's plane held: leased for exactly the duration of `work` when the
 * resolver supports leases, so the plane's connection cannot be closed under it, and released
 * however `work` ends. Against a resolver without `acquire` this is `resolve` then `work`,
 * with no protection beyond what that resolver gives.
 */
export async function withDataPlane<T>(
  resolver: DataPlaneResolver,
  tenantRef: string,
  work: (handle: DataPlaneHandle) => Promise<T>,
  options?: DataPlaneAcquireOptions,
): Promise<T> {
  const lease = await acquireDataPlane(resolver, tenantRef, options);
  try {
    return await work(lease.handle);
  } finally {
    lease.release();
  }
}

/**
 * Caching resolver over host-supplied routing.
 *
 * The host answers two questions — where does this tenant live (`describe`) and
 * how do I open a connection to it (`connect`) — and the framework owns
 * everything else: a bounded set of open data planes, leases that keep a plane open while it
 * is used, deduplication of concurrent resolutions, generation-based revalidation, explicit
 * invalidation, and throwing on an unknown tenant rather than falling back.
 *
 * At most `cacheSize` connections are open at any moment. Opening a plane past that closes
 * the least recently used plane nobody holds a lease on; with every plane leased the caller
 * waits up to `capacityWaitMs` and is then refused with `DataPlaneCapacityError`.
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
  const capacityWaitMs = options.capacityWaitMs ?? DEFAULT_DATA_PLANE_CAPACITY_WAIT_MS;
  assertWaitMs(capacityWaitMs, 'capacityWaitMs');
  const now = options.now ?? Date.now;
  const revalidateAfterMs = options.revalidateAfterMs;
  const maxTotalConnections = options.maxTotalConnections;
  if (
    maxTotalConnections !== undefined &&
    (!Number.isInteger(maxTotalConnections) || maxTotalConnections < 1)
  ) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `Data plane maxTotalConnections must be a positive integer (received ${String(maxTotalConnections)})`,
    );
  }
  const connectionWaitMs = options.connectionWaitMs ?? capacityWaitMs;
  assertWaitMs(connectionWaitMs, 'connectionWaitMs');
  const onCloseError =
    options.onCloseError ??
    ((info: { tenantRef: string; error: unknown }) =>
      logHookError('dataPlaneConnectionClose', info.error));

  /** Insertion-ordered LRU: least recently used first. */
  const entries = new Map<string, CacheEntry>();
  /** Planes out of the cache that still have leases. */
  const retired = new Set<CacheEntry>();
  /** One in-flight resolution per tenant reference. */
  const inFlight = new Map<string, Promise<DataPlaneHandle>>();
  /** Bumped by `invalidate` while a resolution for that tenant is in flight. */
  const epochs = new Map<string, number>();
  /** Callers waiting for a slot; each is woken when a lease, a close or a connect ends. */
  const waiters = new Set<() => void>();
  let closing = 0;
  let connecting = 0;
  let closed = false;
  /** The shared ceiling on server connections, when `maxTotalConnections` is set. */
  const budget: SharedConnectionBudget | undefined =
    maxTotalConnections === undefined
      ? undefined
      : createSharedConnectionBudget({
          max: maxTotalConnections,
          waitMs: connectionWaitMs,
          isClosed: () => closed,
          // Free connections by closing the least recently used plane nobody leases (never the
          // one asking): the same choice `cacheSize` eviction makes.
          reclaim: async (tenantRef) => {
            for (const entry of entries.values()) {
              if (entry.leases === 0 && entry.tenantRef !== tenantRef) {
                await retire(entry);
                return true;
              }
            }
            return false;
          },
          now,
        });

  function currentEpoch(tenantRef: string): number {
    return epochs.get(tenantRef) ?? 0;
  }

  function bumpEpoch(tenantRef: string): void {
    if (inFlight.has(tenantRef)) {
      epochs.set(tenantRef, currentEpoch(tenantRef) + 1);
    }
  }

  function wakeWaiters(): void {
    for (const wake of [...waiters]) wake();
  }

  function slotsInUse(): number {
    return entries.size + retired.size + closing + connecting;
  }

  async function closeQuietly(tenantRef: string, connection: DataPlaneConnection): Promise<void> {
    closing += 1;
    try {
      await connection.close?.();
    } catch (error) {
      onCloseError({ tenantRef, error });
    } finally {
      closing -= 1;
      wakeWaiters();
    }
  }

  /**
   * Take `entry` out of service. Unleased (or when the whole resolver is closing) it is closed
   * now; leased it is retired and closed by its last `release()`.
   */
  async function retire(entry: CacheEntry, force = false): Promise<void> {
    if (entries.get(entry.tenantRef) === entry) entries.delete(entry.tenantRef);
    if (entry.ended) return;
    if (entry.leases > 0 && !force) {
      entry.retired = true;
      retired.add(entry);
      return;
    }
    entry.ended = true;
    retired.delete(entry);
    await closeQuietly(entry.tenantRef, entry.connection);
  }

  async function evict(tenantRef: string): Promise<void> {
    const entry = entries.get(tenantRef);
    if (entry) await retire(entry);
  }

  /** Move an entry to the most-recently-used end of the LRU. */
  function touch(entry: CacheEntry): void {
    entries.delete(entry.tenantRef);
    entries.set(entry.tenantRef, entry);
  }

  function oldestIdle(): CacheEntry | undefined {
    for (const entry of entries.values()) {
      if (entry.leases === 0) return entry;
    }
    return undefined;
  }

  function leaseCount(): number {
    let count = 0;
    for (const entry of entries.values()) count += entry.leases;
    for (const entry of retired) count += entry.leases;
    return count;
  }

  /** Resolve after `ms`, on the next wake-up, or on abort, whichever is first. */
  function waitForSlot(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * Hold one connection slot for a connect about to start. Closes the least recently used
   * unleased plane when the ceiling is reached; with every plane leased, waits (bounded) for
   * a release, then refuses. The caller gives the slot back with `connecting -= 1`.
   */
  async function reserveSlot(tenantRef: string, wait: SlotWait): Promise<void> {
    const started = now();
    for (;;) {
      if (closed) throw closedError(tenantRef);
      if (wait.signal?.aborted) throw abortedError(tenantRef);
      if (slotsInUse() < cacheSize) {
        connecting += 1;
        return;
      }
      const idle = oldestIdle();
      if (idle) {
        await retire(idle);
        continue;
      }
      const remaining = wait.waitMs - (now() - started);
      if (remaining <= 0) {
        throw new DataPlaneCapacityError(tenantRef, {
          cacheSize,
          leases: leaseCount(),
          waitedMs: now() - started,
        });
      }
      await waitForSlot(remaining, wait.signal);
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
    wait: SlotWait,
  ): Promise<DataPlaneHandle | undefined> {
    await reserveSlot(tenantRef, wait);
    let connection: DataPlaneConnection;
    const connectionBudget = budget?.forTenant(tenantRef);
    try {
      connection = await options.connect({
        tenantRef,
        descriptor,
        ...(connectionBudget ? { connectionBudget } : {}),
      });
    } catch (error) {
      connecting -= 1;
      wakeWaiters();
      throw error;
    }
    if (connectionBudget && connection.connectionBudget !== connectionBudget) {
      // A pool outside the ceiling would quietly break it: refuse the plane instead.
      connecting -= 1;
      await closeQuietly(tenantRef, connection);
      throw new PlumbusError(
        ErrorCode.Validation,
        `maxTotalConnections is set, but connect() opened the plane of "${tenantRef}" outside the ` +
          'connection budget: pass request.connectionBudget to openDataPlaneConnection({ connectionBudget })',
        { tenantRef, reason: 'data-plane-connection-budget-unused' },
      );
    }
    // The slot passes from the connect to whatever holds the connection next.
    connecting -= 1;
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
      tenantRef,
      handle,
      connection,
      generation: descriptor.generation,
      coreSchema: handle.coreSchema,
      packageSchemaPrefix: handle.packageSchemaPrefix,
      resolvedAt: now(),
      leases: 0,
      retired: false,
      ended: false,
    };
    const previous = entries.get(tenantRef);
    entries.set(tenantRef, entry);
    if (previous && previous !== entry) await retire(previous);
    return handle;
  }

  async function load(tenantRef: string, wait: SlotWait): Promise<DataPlaneHandle> {
    for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
      const epoch = currentEpoch(tenantRef);
      const descriptor = await describeChecked(tenantRef);
      const handle = await connectAndStore(tenantRef, descriptor, epoch, wait);
      if (handle) return handle;
    }
    throw invalidationRaceError(tenantRef);
  }

  /**
   * Re-read a cached tenant's placement. The cache is read again after the
   * lookup rather than trusted from before it, so an eviction or invalidation
   * that landed meanwhile cannot be overwritten with the older placement.
   */
  async function revalidate(tenantRef: string, wait: SlotWait): Promise<DataPlaneHandle> {
    for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
      const epoch = currentEpoch(tenantRef);
      let descriptor: DataPlaneDescriptor<TConnectionInfo>;
      try {
        descriptor = await describeChecked(tenantRef);
      } catch (error) {
        if (error instanceof UnknownTenantError) {
          // The tenant is gone: stop serving its cached plane (closed once unleased).
          await evict(tenantRef);
        }
        throw error;
      }
      const current = entries.get(tenantRef);
      if (!current || currentEpoch(tenantRef) !== epoch) {
        // Invalidated or evicted while describing — resolve from scratch.
        const handle = await connectAndStore(tenantRef, descriptor, currentEpoch(tenantRef), wait);
        if (handle) return handle;
        continue;
      }
      if (descriptor.generation === current.generation) {
        const coreSchema = descriptor.coreSchema ?? DEFAULT_CORE_SCHEMA;
        const packageSchemaPrefix = descriptor.packageSchemaPrefix ?? DEFAULT_PACKAGE_SCHEMA_PREFIX;
        if (
          coreSchema !== current.coreSchema ||
          packageSchemaPrefix !== current.packageSchemaPrefix
        ) {
          // Updated in place: leases count on this entry, so it must stay the same object.
          current.handle = buildHandle(tenantRef, current.connection.db, descriptor);
          current.coreSchema = coreSchema;
          current.packageSchemaPrefix = packageSchemaPrefix;
        }
        current.resolvedAt = now();
        touch(current);
        return current.handle;
      }
      // Generation moved: the cached connection points at a superseded placement. Stop
      // handing it out (closed now, or by its last lease) before connecting to the new one.
      await retire(current);
      const handle = await connectAndStore(tenantRef, descriptor, epoch, wait);
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

  function abortedError(tenantRef: string): PlumbusError {
    return new PlumbusError(
      ErrorCode.Cancelled,
      `Waiting for a data plane slot for tenant reference "${tenantRef}" was aborted`,
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

  async function resolveWith(tenantRef: string, wait: SlotWait): Promise<DataPlaneHandle> {
    if (closed) {
      throw closedError(tenantRef);
    }
    assertTenantRef(tenantRef);

    const cached = entries.get(tenantRef);
    if (cached && !isStale(cached)) {
      touch(cached);
      return cached.handle;
    }
    if (cached) {
      return start(tenantRef, () => revalidate(tenantRef, wait));
    }
    return start(tenantRef, () => load(tenantRef, wait));
  }

  function leaseOf(entry: CacheEntry): DataPlaneLease {
    entry.leases += 1;
    let released = false;
    return Object.freeze({
      handle: entry.handle,
      release() {
        if (released) return;
        released = true;
        entry.leases -= 1;
        if (entry.leases > 0) return;
        if (entry.retired && !entry.ended) {
          entry.ended = true;
          retired.delete(entry);
          void closeQuietly(entry.tenantRef, entry.connection);
        }
        wakeWaiters();
      },
    });
  }

  return {
    async resolve(tenantRef: string): Promise<DataPlaneHandle> {
      return resolveWith(tenantRef, { waitMs: capacityWaitMs });
    },

    async acquire(tenantRef: string, acquireOptions?: DataPlaneAcquireOptions) {
      const waitMs = acquireOptions?.waitMs ?? capacityWaitMs;
      assertWaitMs(waitMs, 'waitMs');
      const wait: SlotWait = { waitMs, signal: acquireOptions?.signal };
      for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
        const handle = await resolveWith(tenantRef, wait);
        // Leased in the same turn the cache is read, so no eviction can come in between.
        const entry = entries.get(tenantRef);
        if (entry && entry.handle === handle && !entry.ended) return leaseOf(entry);
        // Evicted or replaced between the resolution and here: resolve again.
      }
      throw invalidationRaceError(tenantRef);
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
      for (const entry of [...entries.values()]) {
        await retire(entry);
      }
    },

    async close(): Promise<void> {
      closed = true;
      for (const tenantRef of [...inFlight.keys()]) {
        bumpEpoch(tenantRef);
      }
      wakeWaiters();
      budget?.wakeAll();
      for (const entry of [...entries.values(), ...retired]) {
        await retire(entry, true);
      }
    },

    stats() {
      return {
        capacity: cacheSize,
        cached: entries.size,
        retired: retired.size,
        closing,
        connecting,
        leases: leaseCount(),
        waiting: waiters.size,
        ...(budget ? { connections: budget.stats() } : {}),
      };
    },
  };
}

interface SlotWait {
  waitMs: number;
  signal?: AbortSignal;
}

function assertWaitMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `Data plane ${name} must be a whole number of milliseconds, 0 or more (received ${String(value)})`,
    );
  }
}
