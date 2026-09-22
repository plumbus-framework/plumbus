import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { DatabaseConfig } from '../types/config.js';

/** Typed database handle for CLI and server bootstrap (M3). */
export interface DatabaseConnection {
  db: PostgresJsDatabase;
  /** Live postgres.js client; omitted when tests inject `db` only. */
  sql?: postgres.Sql;
}

export async function connectPostgresDatabase(config: DatabaseConfig): Promise<DatabaseConnection> {
  const postgresModule = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const sql = postgresModule({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
  });
  return { db: drizzle(sql), sql };
}

export async function resolveDatabaseConnection(
  config: DatabaseConfig,
  options: { db?: PostgresJsDatabase; connection?: DatabaseConnection },
): Promise<DatabaseConnection> {
  if (options.connection) {
    return options.connection;
  }
  if (options.db) {
    return { db: options.db };
  }
  return connectPostgresDatabase(config);
}

export async function closeDatabaseConnection(connection: DatabaseConnection): Promise<void> {
  if (connection.sql) {
    await connection.sql.end({ timeout: 5 });
  }
}
