import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { DatabaseConfig } from '../types/config.js';

/** Typed database handle for CLI and server bootstrap (M3). */
export interface DatabaseConnection {
  db: PostgresJsDatabase;
  /** Live postgres.js client; omitted when tests inject `db` only. */
  sql?: postgres.Sql;
}

/** The postgres.js options every framework connection built from `config.database` shares. */
export interface PostgresConnectionOptions {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

/**
 * postgres.js options for the configured database — the one place they are assembled, so
 * every connection made from `config.database` (the server and worker pool, `plumbus seed`,
 * `plumbus run`, `migrate`'s maintenance connections) carries the same TLS decision.
 *
 * `ssl` is passed through as configured: `loadConfig` sets it in production (and from
 * `DATABASE_SSL=true`), and `true` makes postgres.js negotiate TLS and verify the server's
 * certificate (add a private CA with `NODE_EXTRA_CA_CERTS`). Leaving it out used to connect
 * in plain text even when the configuration asked for TLS, which a Postgres that requires TLS
 * refuses — Amazon RDS for PostgreSQL 15+ (`rds.force_ssl=1`) answers `28000 no encryption`.
 *
 * @param database Defaults to the configured database; maintenance work passes `'postgres'`.
 */
export function postgresConnectionOptions(
  config: DatabaseConfig,
  database: string = config.database,
): PostgresConnectionOptions {
  return {
    host: config.host,
    port: config.port,
    database,
    username: config.user,
    password: config.password,
    ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
  };
}

export async function connectPostgresDatabase(config: DatabaseConfig): Promise<DatabaseConnection> {
  const postgresModule = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const sql = postgresModule(postgresConnectionOptions(config));
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
