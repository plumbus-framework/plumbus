import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { DatabaseConfig } from '../types/config.js';
import type { LoggerService } from '../types/context.js';

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

export interface PostgresConnectionOptionsSettings {
  /** Receives the one-time "not using TLS" warning (default: `console.warn`). */
  logger?: Pick<LoggerService, 'warn'>;
}

let warnedSslNotEnforced = false;

/** @internal Test hook — re-arm the one-time TLS warning. */
export function resetSslWarningForTests(): void {
  warnedSslNotEnforced = false;
}

/**
 * postgres.js options for the configured database — the one place they are assembled, so
 * every connection made from `config.database` (server and worker pool, `plumbus seed`,
 * `plumbus run`, `migrate`'s maintenance connections) carries the same TLS decision.
 *
 * 0.8.x compatibility: `loadConfig` sets `ssl: true` in production (and from
 * `DATABASE_SSL=true`), but earlier 0.8 releases never handed it to the driver, so many
 * deployments run against plaintext Postgres. `ssl` is therefore passed through only when
 * `sslEnforce` is true (`DATABASE_SSL_ENFORCE=true`). `ssl: true` makes postgres.js negotiate
 * TLS and verify the server certificate (add a private CA with `NODE_EXTRA_CA_CERTS`). When
 * `ssl` is set without enforcement, a one-time warning says the connection is not using TLS.
 *
 * @param database Defaults to the configured database; maintenance work passes `'postgres'`.
 */
export function postgresConnectionOptions(
  config: DatabaseConfig,
  database: string = config.database,
  settings: PostgresConnectionOptionsSettings = {},
): PostgresConnectionOptions {
  const enforce = config.sslEnforce === true;
  if (config.ssl === true && !enforce && !warnedSslNotEnforced) {
    warnedSslNotEnforced = true;
    const message =
      'database.ssl is set but the PostgreSQL connection is NOT using TLS (Plumbus 0.8 does not ' +
      'apply it by default). Set DATABASE_SSL_ENFORCE=true (or database.sslEnforce: true) to ' +
      'connect over TLS with certificate verification.';
    if (settings.logger) settings.logger.warn(message, { host: config.host });
    else console.warn(`[plumbus] ${message}`);
  }
  return {
    host: config.host,
    port: config.port,
    database,
    username: config.user,
    password: config.password,
    ...(enforce && config.ssl !== undefined ? { ssl: config.ssl } : {}),
  };
}

export async function connectPostgresDatabase(
  config: DatabaseConfig,
  settings: PostgresConnectionOptionsSettings = {},
): Promise<DatabaseConnection> {
  const postgresModule = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const sql = postgresModule(postgresConnectionOptions(config, config.database, settings));
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
