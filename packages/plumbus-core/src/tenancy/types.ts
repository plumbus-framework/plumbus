// ── Tenancy Types ──
// Data-plane resolution: the framework mechanism that turns an opaque tenant
// reference into the database handle plus schema namespaces its work runs in.
// The framework owns caching, invalidation and fail-closed behavior; the host
// application owns the lookup (where tenant routing lives) and the connect
// step (how a connection is opened).

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  DataPlaneConnectionBudget,
  DataPlaneConnectionBudgetStats,
} from './connection-budget.js';

/**
 * A resolved data plane — everything a request, flow step or worker needs to
 * read and write one tenant's state.
 *
 * `coreSchema` and `packageSchemaPrefix` are the namespaces the framework's own
 * tables and the per-package tables live in. Handles are frozen: a caller that
 * receives one cannot repoint it at another tenant.
 */
export interface DataPlaneHandle {
  /** Database handle for this tenant's data plane. */
  db: PostgresJsDatabase;
  /** Schema holding the framework's own tenant-local tables. */
  coreSchema: string;
  /** Prefix for per-package schemas (a package's schema is `${prefix}${package}`). */
  packageSchemaPrefix: string;
  /** The opaque tenant reference this handle was resolved for. */
  tenantRef: string;
  /**
   * Monotonic generation of the tenant's data plane, when the host tracks one.
   * A changed generation means the placement changed (restore, move, rotation)
   * and any handle carrying the older value is stale.
   */
  generation?: number;
}

/**
 * What a plane is resolved for. `'background'` is the framework's own periodic work (outbox
 * pump, scheduler, sweeps, retention); `'request'` is work done for a caller. A host resolver
 * may use it to choose a cheaper routing check for background work; it never changes which
 * plane a tenant resolves to.
 */
export type DataPlanePurpose = 'request' | 'background';

/** Options a resolver may receive with `resolve`. Resolvers that ignore them stay correct. */
export interface DataPlaneResolveOptions {
  purpose?: DataPlanePurpose;
}

/** Options for {@link DataPlaneResolver.acquire}. */
export interface DataPlaneAcquireOptions extends DataPlaneResolveOptions {
  /**
   * How long to wait for a free connection slot when every open plane is leased, in
   * milliseconds. Default: the resolver's `capacityWaitMs`.
   */
  waitMs?: number;
  /** Abandons the wait (the acquire rejects) when aborted. */
  signal?: AbortSignal;
}

/**
 * A data plane held for one unit of use. While any lease on a plane is held, the resolver
 * never closes that plane's connection: not to make room for another tenant, not on
 * `invalidate`, not on a generation change (it stops handing the plane out and closes it
 * after the last lease is released). Only `close()` of the whole resolver ends it.
 */
export interface DataPlaneLease {
  readonly handle: DataPlaneHandle;
  /** Give the plane back. Idempotent. The handle must not be used afterwards. */
  release(): void;
}

/**
 * Resolves an opaque tenant reference to its data plane.
 *
 * Implementations MUST fail closed: an unresolvable reference throws, and no
 * implementation may fall back to a default database — that would be a
 * cross-tenant leak.
 */
export interface DataPlaneResolver {
  /**
   * The tenant's plane, without a lease. A pooled resolver may close the returned handle's
   * connection once it is the least recently used unleased plane and another tenant needs
   * the slot, so a caller that holds the handle across awaits should use `acquire`.
   */
  resolve(tenantRef: string, options?: DataPlaneResolveOptions): Promise<DataPlaneHandle>;
  /**
   * The tenant's plane under a lease: the connection stays open until `release()`. Optional
   * so existing host resolvers keep compiling; the framework uses it when present
   * (`withDataPlane`) and falls back to `resolve` otherwise. A host resolver that wraps
   * `createPooledDataPlaneResolver` should forward it.
   */
  acquire?(tenantRef: string, options?: DataPlaneAcquireOptions): Promise<DataPlaneLease>;
  /**
   * Drop any cached handle for `tenantRef` so the next `resolve` re-reads the
   * host's routing. Absent on resolvers that hold no cache.
   */
  invalidate?(tenantRef: string): Promise<void>;
}

/**
 * What the host reports about a tenant's data plane placement.
 *
 * `connectionInfo` is opaque to the framework — it is handed back verbatim to
 * `connect`, so hosts can carry connection strings, credential references,
 * pool names, or anything else their connect step needs.
 */
export interface DataPlaneDescriptor<TConnectionInfo = unknown> {
  /** Host-defined connection details, passed through to `connect` unchanged. */
  connectionInfo: TConnectionInfo;
  /** Schema holding the framework's own tenant-local tables. */
  coreSchema?: string;
  /** Prefix for per-package schemas. */
  packageSchemaPrefix?: string;
  /**
   * Monotonic generation of this placement. When revalidation observes a
   * changed generation the pooled resolver closes the old connection and
   * connects again; an unchanged generation keeps the existing connection.
   */
  generation?: number;
}

/** An open connection to one tenant's data plane, owned by the resolver. */
export interface DataPlaneConnection {
  db: PostgresJsDatabase;
  /** Called when the resolver evicts, invalidates or closes this connection. */
  close?(): Promise<void>;
  /**
   * The connection budget this pool opens its connections under (`openDataPlaneConnection`
   * sets it from its `connectionBudget` option). A resolver with `maxTotalConnections` refuses a
   * plane whose connection does not report its budget.
   */
  connectionBudget?: DataPlaneConnectionBudget;
}

/** Arguments handed to the host's `connect` step. */
export interface DataPlaneConnectRequest<TConnectionInfo = unknown> {
  tenantRef: string;
  descriptor: DataPlaneDescriptor<TConnectionInfo>;
  /**
   * Present when the resolver has `maxTotalConnections`: pass it to
   * `openDataPlaneConnection({ connectionBudget })` so every connection of this plane counts
   * against the shared ceiling.
   */
  connectionBudget?: DataPlaneConnectionBudget;
}

export interface PooledDataPlaneResolverOptions<TConnectionInfo = unknown> {
  /**
   * Look up a tenant's placement. Return `undefined` or `null` for an unknown
   * tenant — the resolver then throws `UnknownTenantError` and never falls
   * back to another database.
   */
  describe(tenantRef: string): Promise<DataPlaneDescriptor<TConnectionInfo> | undefined | null>;
  /** Open a connection for a described tenant. */
  connect(request: DataPlaneConnectRequest<TConnectionInfo>): Promise<DataPlaneConnection>;
  /**
   * Most data-plane connections (pools) open at once, default 32. This is a ceiling, not a
   * target: it counts cached planes, planes still leased after an invalidation, planes being
   * closed and connections being opened. `cacheSize × the pool size per plane` is the
   * connection budget a host sizes its database against. To open a plane when the ceiling
   * is reached, the resolver closes the least recently used plane nobody holds a lease on;
   * when every plane is leased it waits up to `capacityWaitMs` for one to be released and
   * then refuses with `DataPlaneCapacityError`.
   */
  cacheSize?: number;
  /**
   * How long `resolve` / `acquire` wait for a free slot when every open plane is leased, in
   * milliseconds (default {@link DEFAULT_DATA_PLANE_CAPACITY_WAIT_MS}). `acquire` can
   * override it per call (`waitMs`).
   */
  capacityWaitMs?: number;
  /**
   * One ceiling on server connections across every plane this resolver opens, whatever their
   * pool sizes. Unset (the default): no shared ceiling — `cacheSize × pool size` bounds them.
   *
   * Set, `connect` receives `request.connectionBudget` and must open the plane under it
   * (`openDataPlaneConnection({ connectionBudget })`); a plane whose connection does not report
   * that budget is closed and refused. Every connection takes a slot before its socket opens and
   * gives it back when the socket closes (idle timeout, lifetime, pool close). With no free slot
   * the resolver closes the least recently used plane nobody leases (as `cacheSize` eviction
   * does), then waits up to `connectionWaitMs`, then refuses with
   * `DataPlaneConnectionBudgetError` (HTTP 503). A leased plane's connections are never closed to
   * make room; its idle connections keep their slots until the pool's idle timeout, so keep
   * `idleTimeoutSeconds` short where the budget is tight.
   */
  maxTotalConnections?: number;
  /**
   * How long a connection waits for a free slot under `maxTotalConnections`, in milliseconds.
   * Default: `capacityWaitMs`.
   */
  connectionWaitMs?: number;
  /**
   * Re-run `describe` for a cached tenant once its entry is older than this
   * many milliseconds. Omitted (the default) means cached entries are only
   * refreshed by an explicit `invalidate`.
   */
  revalidateAfterMs?: number;
  /** Clock source, injectable for tests (default `Date.now`). */
  now?: () => number;
  /** Notified when closing an evicted connection fails (default: logs). */
  onCloseError?: (info: { tenantRef: string; error: unknown }) => void;
}

/** What a pooled resolver holds right now (for health checks, metrics and tests). */
export interface DataPlaneResolverStats {
  /** `cacheSize`: the most connections open at once. */
  capacity: number;
  /** Planes in the cache (handed out by `resolve` / `acquire`). */
  cached: number;
  /** Planes taken out of the cache (invalidated, superseded) that still have leases. */
  retired: number;
  /** Connections being closed. */
  closing: number;
  /** Connections being opened. */
  connecting: number;
  /** Leases held now, over cached and retired planes. */
  leases: number;
  /** Callers waiting for a free slot. */
  waiting: number;
  /** Server connections under `maxTotalConnections`; absent without a shared ceiling. */
  connections?: DataPlaneConnectionBudgetStats;
}

/** A `DataPlaneResolver` that caches connections and can be invalidated. */
export interface PooledDataPlaneResolver extends DataPlaneResolver {
  resolve(tenantRef: string, options?: DataPlaneResolveOptions): Promise<DataPlaneHandle>;
  acquire(tenantRef: string, options?: DataPlaneAcquireOptions): Promise<DataPlaneLease>;
  /**
   * Drop the cached data plane for one tenant. Its connection is closed now when nobody holds
   * a lease on it, else when the last lease is released.
   */
  invalidate(tenantRef: string): Promise<void>;
  /** `invalidate` for every cached data plane. */
  invalidateAll(): Promise<void>;
  /**
   * Close every data plane, leased or not; further `resolve` / `acquire` calls throw and
   * callers waiting for a slot are refused. For shutdown.
   */
  close(): Promise<void>;
  /** A snapshot of open, leased and waiting counts. */
  stats(): DataPlaneResolverStats;
}

/** Options for the single-data-plane (back-compat) resolver. */
export interface SingleDataPlaneResolverOptions {
  /** Schema holding the framework's own tables (default `public`). */
  coreSchema?: string;
  /** Prefix for per-package schemas (default `pkg_`). */
  packageSchemaPrefix?: string;
  /** Generation reported on every handle, when the host tracks one. */
  generation?: number;
}
