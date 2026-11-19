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
  DEFAULT_MIGRATION_LOCK_RETRIES,
  DEFAULT_MIGRATION_LOCK_RETRY_DELAY_MS,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  listInvalidIndexes,
  MIGRATION_ADVISORY_LOCK_KEY,
  MIGRATION_NO_TRANSACTION_DIRECTIVE,
  MigrationInvalidIndexError,
  MigrationLockTimeoutError,
  MigrationStatementError,
  readPendingMigrations,
  rollbackLastMigration,
  type InvalidIndex,
  type MigrationApplyResult,
  type MigrationConfig,
  type MigrationLockRetryInfo,
  type MigrationRecord,
  type MigrationRollbackResult,
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
export {
  closeDatabaseConnection,
  connectPostgresDatabase,
  resolveDatabaseConnection,
  type DatabaseConnection,
} from './connection.js';
export { EntityRegistry } from './registry.js';
export {
  collectMaskedFieldsFromEntities,
  getMaskedFields,
} from './mask-fields.js';
export {
  decryptBytes,
  decryptFieldValue,
  encryptBytes,
  encryptFieldValue,
  getEncryptedFields,
  isEncryptedValue,
  resolveEncryptionKey,
  ENCRYPTION_PREFIX,
} from './field-encryption.js';
export { resolveSelectedFields } from './projection.js';
export { createRepository, type RepositoryOptions } from './repository.js';
export { generateDrizzleSchema, generateSchemas } from './schema-generator.js';
