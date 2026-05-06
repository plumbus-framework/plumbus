// ── Data Layer Module ──
// Persistence: entity registry, repository factory, Drizzle schema generation,
// and database migrations. Used by ctx.data in capability handlers.
//
// Key exports: createRepository, EntityRegistry, generateDrizzleSchema, applyMigrations

// Re-export Drizzle operators for use in query conditions
export { gte, ilike, like, lte, sql } from 'drizzle-orm';
export {
  applyMigrations,
  collectSchemas,
  readPendingMigrations,
  rollbackLastMigration,
  type MigrationApplyResult,
  type MigrationConfig,
  type MigrationRecord,
  type PendingMigration,
} from './migration.js';
export {
  extractCreateTableNames,
  formatDriftReport,
  FRAMEWORK_TABLE_NAMES,
  getExistingFrameworkTables,
  inspectFrameworkDrift,
  type ColumnDrift,
  type DriftReport,
  type FrameworkTableName,
  type TableDrift,
} from './drift-inspector.js';
export { EntityRegistry } from './registry.js';
export { createRepository, type RepositoryOptions } from './repository.js';
export { generateDrizzleSchema, generateSchemas } from './schema-generator.js';
