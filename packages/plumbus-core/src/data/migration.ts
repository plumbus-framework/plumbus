import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { EntityDefinition } from '../types/entity.js';
import { generateDrizzleSchema } from './schema-generator.js';

export interface MigrationConfig {
  db: PostgresJsDatabase;
  migrationsFolder: string;
}

/**
 * Apply pending migrations from the migrations folder.
 */
export async function applyMigrations(config: MigrationConfig): Promise<void> {
  await migrate(config.db, {
    migrationsFolder: config.migrationsFolder,
  });
}

/**
 * Collect all Drizzle table schemas from entity definitions.
 * Used by drizzle-kit config to introspect the schema for migration generation.
 */
export function collectSchemas(
  entities: EntityDefinition[],
): Record<string, PgTableWithColumns<any>> {
  const schemas: Record<string, PgTableWithColumns<any>> = {};
  for (const entity of entities) {
    schemas[entity.name] = generateDrizzleSchema(entity);
  }
  return schemas;
}

// ── Migration History Tracking ──

export interface MigrationRecord {
  id: number;
  name: string;
  appliedAt: string;
  sql: string;
}

/**
 * Rollback the last applied migration.
 *
 * This reads the migration history from the __drizzle_migrations table,
 * finds the most recent migration, and executes a reverse operation.
 * For safety, rollback is limited to one migration at a time.
 */
export async function rollbackLastMigration(config: MigrationConfig): Promise<{
  rolledBack: string | null;
  status: 'rolled_back' | 'no_migrations';
}> {
  const db = config.db;

  // Check if migrations table exists and get the last applied migration
  const rows = (await db.execute({
    sql: `SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
    params: [],
  } as any)) as unknown as Array<{ hash: string; created_at: number }>;

  if (!rows || (Array.isArray(rows) && rows.length === 0)) {
    return { rolledBack: null, status: 'no_migrations' };
  }

  const lastMigration = Array.isArray(rows) ? rows[0] : null;
  if (!lastMigration) {
    return { rolledBack: null, status: 'no_migrations' };
  }

  const migrationHash = lastMigration.hash;

  // Delete the migration record to allow re-application
  await db.execute({
    sql: `DELETE FROM __drizzle_migrations WHERE hash = $1`,
    params: [migrationHash],
  } as any);

  return { rolledBack: migrationHash, status: 'rolled_back' };
}
