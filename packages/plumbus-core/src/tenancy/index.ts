// ── Tenancy Module ──
// Per-tenant data-plane resolution: the mechanism that maps an opaque tenant
// reference to the database handle and schema namespaces its work runs in.
// The framework owns caching, invalidation and fail-closed behavior; the host
// application owns routing lookup and connection creation.
//
// Key exports: createSingleDataPlaneResolver (back-compat single database),
// createPooledDataPlaneResolver (host-routed, cached), openDataPlaneConnection
// (the connect step it routes through), applyDataPlaneMigrations (owner-role
// apply of generated migrations to a named tenant database), UnknownTenantError.

export {
  createPooledDataPlaneResolver,
  createSingleDataPlaneResolver,
  UnknownTenantError,
  DEFAULT_CORE_SCHEMA,
  DEFAULT_DATA_PLANE_CACHE_SIZE,
  DEFAULT_PACKAGE_SCHEMA_PREFIX,
} from './data-plane-resolver.js';
export type {
  DataPlaneConnectRequest,
  DataPlaneConnection,
  DataPlaneDescriptor,
  DataPlaneHandle,
  DataPlaneResolver,
  PooledDataPlaneResolver,
  PooledDataPlaneResolverOptions,
  SingleDataPlaneResolverOptions,
} from './types.js';

// Opening a data plane: a bounded, per-tenant pool against one named database,
// opened as one named role, in the shape `connect` must return. Credentials
// never reach a message, an error's metadata, or the notice stream.
export {
  openDataPlaneConnection,
  DataPlaneConnectionError,
  DEFAULT_DATA_PLANE_POOL_SIZE,
  MAX_DATA_PLANE_POOL_SIZE,
} from './data-plane-connection.js';
export type {
  DataPlaneConnectionFields,
  DataPlaneConnectionTarget,
  DataPlaneConnectionUrl,
  DataPlaneEndpoint,
  OpenDataPlaneConnectionOptions,
  OpenedDataPlaneConnection,
} from './data-plane-connection.js';

// Apply generated migrations to one named tenant database through the same
// connection factory the resolver uses. Connect as the owner role.
export {
  applyDataPlaneMigrations,
  DATA_PLANE_MIGRATE_APPLICATION_NAME,
} from './data-plane-migrate.js';
export type {
  ApplyDataPlaneMigrationsOptions,
  DataPlaneMigrationApplyResult,
} from './data-plane-migrate.js';

// Data-plane provisioning: creating a tenant's database and its owner/runtime role pair.
// Idempotent and resumable; identifiers are validated and quoted, never interpolated.
export {
  provisionDataPlane,
  dropDataPlane,
  assertSafeIdentifier,
  quoteIdentifier,
  DataPlaneGuardError,
  DataPlaneNameError,
  DataPlaneProvisioningError,
} from './data-plane-provisioning.js';
export type {
  DataPlaneAdminConnection,
  DataPlaneDropResult,
  DataPlaneRoleSpec,
  DataPlaneStep,
  DataPlaneStepName,
  DataPlaneStepOutcome,
  DataPlaneTablePrivilege,
  DropDataPlaneOptions,
  ProvisionDataPlaneOptions,
  DataPlaneProvisionResult,
} from './data-plane-provisioning.js';
