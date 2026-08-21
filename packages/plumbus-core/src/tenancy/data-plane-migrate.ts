// ── Data-plane migrations ──
// A host applies the same generated framework/app migrations to one named
// tenant database. The connection is the existing factory
// (`openDataPlaneConnection`); the SQL runner is the existing
// `applyMigrations`. This module only composes those two and always closes.
//
// Connect as the owner role from `provisionDataPlane`. The runtime role is
// DML-only and cannot apply schema.

import { applyMigrations, type MigrationApplyResult } from '../data/migration.js';
import {
  openDataPlaneConnection,
  type DataPlaneConnectionTarget,
} from './data-plane-connection.js';

export const DATA_PLANE_MIGRATE_APPLICATION_NAME = 'plumbus-migrate';

export interface ApplyDataPlaneMigrationsOptions {
  /** Named tenant database, opened as the role that may run DDL (typically the owner). */
  target: DataPlaneConnectionTarget;
  /** Folder that holds generated SQL and `meta/_journal.json` (usually `drizzle/`). */
  migrationsFolder: string;
  /**
   * Maximum connections this one-shot apply may open. Default 1.
   * Must stay within the factory ceiling.
   */
  maxConnections?: number;
  /** Reported to the server as `application_name`. Default `plumbus-migrate`. */
  applicationName?: string;
}

export interface DataPlaneMigrationApplyResult extends MigrationApplyResult {
  /** The database name when the target named one (fields target, or URL override). */
  database?: string;
}

function databaseNameOf(target: DataPlaneConnectionTarget): string | undefined {
  if (typeof (target as { database?: unknown }).database === 'string') {
    return (target as { database: string }).database;
  }
  return undefined;
}

/**
 * Open one named tenant database through `openDataPlaneConnection` and apply
 * pending migrations from `migrationsFolder`. Always closes the pool, including
 * when apply fails.
 *
 * This is the host-side counterpart of `plumbus migrate apply --database`.
 * It does not create the database or roles — call `provisionDataPlane` first.
 */
export async function applyDataPlaneMigrations(
  options: ApplyDataPlaneMigrationsOptions,
): Promise<DataPlaneMigrationApplyResult> {
  const connection = await openDataPlaneConnection({
    target: options.target,
    maxConnections: options.maxConnections ?? 1,
    applicationName: options.applicationName ?? DATA_PLANE_MIGRATE_APPLICATION_NAME,
  });

  try {
    const result = await applyMigrations({
      db: connection.db,
      migrationsFolder: options.migrationsFolder,
    });
    const database = databaseNameOf(options.target);
    return database === undefined ? result : { ...result, database };
  } finally {
    await connection.close();
  }
}
