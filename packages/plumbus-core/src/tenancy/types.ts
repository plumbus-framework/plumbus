// ── Tenancy Types ──
// Data-plane resolution: the framework mechanism that turns an opaque tenant
// reference into the database handle plus schema namespaces its work runs in.
// The framework owns caching, invalidation and fail-closed behavior; the host
// application owns the lookup (where tenant routing lives) and the connect
// step (how a connection is opened).

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

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
 * Resolves an opaque tenant reference to its data plane.
 *
 * Implementations MUST fail closed: an unresolvable reference throws, and no
 * implementation may fall back to a default database — that would be a
 * cross-tenant leak.
 */
export interface DataPlaneResolver {
  resolve(tenantRef: string): Promise<DataPlaneHandle>;
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
}

/** Arguments handed to the host's `connect` step. */
export interface DataPlaneConnectRequest<TConnectionInfo = unknown> {
  tenantRef: string;
  descriptor: DataPlaneDescriptor<TConnectionInfo>;
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
  /** Maximum number of cached data planes (LRU, default 32). */
  cacheSize?: number;
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

/** A `DataPlaneResolver` that caches connections and can be invalidated. */
export interface PooledDataPlaneResolver extends DataPlaneResolver {
  resolve(tenantRef: string): Promise<DataPlaneHandle>;
  /** Evict and close the cached data plane for one tenant. */
  invalidate(tenantRef: string): Promise<void>;
  /** Evict and close every cached data plane. */
  invalidateAll(): Promise<void>;
  /** Close every cached data plane; further `resolve` calls throw. */
  close(): Promise<void>;
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
