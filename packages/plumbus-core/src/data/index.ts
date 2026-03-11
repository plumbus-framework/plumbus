// ── Data Layer Module ──
// Persistence: entity registry, repository factory, Drizzle schema generation,
// and database migrations. Used by ctx.data in capability handlers.
//
// Key exports: createRepository, EntityRegistry, generateDrizzleSchema, applyMigrations

export {
  applyMigrations,
  collectSchemas,
  rollbackLastMigration,
  type MigrationConfig,
  type MigrationRecord,
} from './migration.js';
export { EntityRegistry } from './registry.js';
export { createRepository, type RepositoryOptions } from './repository.js';
export { generateDrizzleSchema, generateSchemas } from './schema-generator.js';
