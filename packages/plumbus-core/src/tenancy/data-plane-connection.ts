// ── Data-Plane Connections ──
// Opening one data plane: a pooled connection to a named database, opened as a
// named role, handed back in the `{ db, close }` shape the pooled resolver's
// `connect` step has to produce.
//
// `createPooledDataPlaneResolver` deliberately does not know how a connection is
// made — the host answers that. Without a framework-supplied answer every host
// reaches for the raw driver, which is where unbounded pools and credentials in
// error messages come from. This is that answer, with three properties a
// hand-rolled `connect` rarely has:
//
//   bounded    — a ceiling is always applied (`DEFAULT_DATA_PLANE_POOL_SIZE` by
//                default, never above `MAX_DATA_PLANE_POOL_SIZE`), so a resolver
//                holding many data planes open cannot multiply into an unbounded
//                number of server backends.
//   quiet      — no password and no connection string reaches a message, error
//                metadata or the notice stream. Failures are re-raised as
//                `DataPlaneConnectionError` carrying only host, port, database,
//                role and SQLSTATE, with the driver's text scrubbed of secrets.
//   per-tenant — every call builds its own client and its own `close`, sharing
//                no state with any other call, so it is safe to invoke once per
//                tenant. `close` is idempotent and closes the whole pool.
//
// By default the connection is verified with a round trip before it is returned,
// so a wrong credential or an unreachable placement fails at resolve time rather
// than inside the first capability that happens to query.
//
// Key exports: openDataPlaneConnection, DataPlaneConnectionError.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';
import type { DataPlaneConnection } from './types.js';

/** Connections a data-plane pool holds when the caller names no ceiling. */
export const DEFAULT_DATA_PLANE_POOL_SIZE = 5;

/**
 * Largest pool one data plane may hold. A resolver caches many data planes at
 * once, so the per-tenant ceiling is what keeps the total number of server
 * backends finite; a request for more is a configuration error, not a tuning
 * choice the framework silently honours.
 */
export const MAX_DATA_PLANE_POOL_SIZE = 64;

const DEFAULT_PORT = 5432;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30;
const DEFAULT_CLOSE_TIMEOUT_SECONDS = 5;

/** What a scrubbed secret is replaced with wherever one could have appeared. */
const REDACTED = '[redacted]';

const NUL = '\u0000';

// ── Errors ──

/**
 * A data plane could not be opened, or the connection did not answer.
 *
 * Carries only non-secret coordinates: `host`, `port`, `database`, `user` and,
 * when the server rejected the attempt, `sqlState`. The driver's own error is
 * never re-thrown and never attached, because its text and its fields are
 * outside this module's control.
 */
export class DataPlaneConnectionError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Internal, message, metadata);
    this.name = 'DataPlaneConnectionError';
  }
}

function validationError(message: string, metadata?: Record<string, unknown>): PlumbusError {
  return new PlumbusError(ErrorCode.Validation, message, metadata);
}

// ── Target ──

/** A data plane addressed by its parts. Structurally accepts a `DatabaseConfig`. */
export interface DataPlaneConnectionFields {
  host: string;
  /** Default 5432. */
  port?: number;
  /** The database to open — one tenant's data plane, not a cluster default. */
  database: string;
  /** The role to open it as; typically the least-privilege runtime role. */
  user: string;
  /** Omit for a role that authenticates without one (peer, trust, IAM). */
  password?: string;
  ssl?: boolean | 'require' | 'allow' | 'prefer' | 'verify-full';
}

/**
 * A data plane addressed by URL, for hosts whose placement records carry one.
 * The string is treated as a secret throughout: it is never logged and never
 * reproduced in an error.
 */
export interface DataPlaneConnectionUrl {
  connectionString: string;
  /** Open this database instead of the one the URL names. */
  database?: string;
}

/** Where a data plane lives and which role opens it. */
export type DataPlaneConnectionTarget = DataPlaneConnectionFields | DataPlaneConnectionUrl;

/** The non-secret coordinates of a target — what a failure is allowed to say. */
export interface DataPlaneEndpoint {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

export interface OpenDataPlaneConnectionOptions {
  /** The database to open and the credentials to open it with. */
  target: DataPlaneConnectionTarget;
  /**
   * Maximum connections this pool opens. Default
   * `DEFAULT_DATA_PLANE_POOL_SIZE`; must be an integer between 1 and
   * `MAX_DATA_PLANE_POOL_SIZE`.
   */
  maxConnections?: number;
  /** Default 10. */
  connectTimeoutSeconds?: number;
  /** Idle connections are released after this long. Default 30. */
  idleTimeoutSeconds?: number;
  /** Recycle a connection after this long, when the deployment requires it. */
  maxLifetimeSeconds?: number;
  /** Grace period `close` allows in-flight work before ending the pool. Default 5. */
  closeTimeoutSeconds?: number;
  /** Reported to the server as `application_name`; visible in `pg_stat_activity`. */
  applicationName?: string;
  /**
   * Round-trip a probe before returning, so an unusable placement fails here
   * rather than inside the first query. Default true.
   */
  verify?: boolean;
}

/** An open data plane. `close` is always present and always idempotent. */
export interface OpenedDataPlaneConnection extends DataPlaneConnection {
  db: PostgresJsDatabase;
  close(): Promise<void>;
}

interface TargetBase {
  endpoint: DataPlaneEndpoint;
  /** Every literal that must never reach a message. */
  secrets: string[];
}

interface NormalizedFieldsTarget extends TargetBase {
  kind: 'fields';
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl?: boolean | 'require' | 'allow' | 'prefer' | 'verify-full';
}

interface NormalizedUrlTarget extends TargetBase {
  kind: 'url';
  connectionString: string;
  databaseOverride?: string;
}

type NormalizedTarget = NormalizedFieldsTarget | NormalizedUrlTarget;

function isConnectionUrl(target: DataPlaneConnectionTarget): target is DataPlaneConnectionUrl {
  return typeof (target as { connectionString?: unknown }).connectionString === 'string';
}

/**
 * Connection parameters travel in the startup packet, where a NUL terminates the
 * value: a parameter carrying one is refused rather than silently truncated.
 */
function assertParameter(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${field} must be a non-empty string`, { field });
  }
  if (value.includes(NUL)) {
    throw validationError(`${field} must not contain a NUL character`, { field });
  }
  return value;
}

function assertPort(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw validationError(`${field} must be an integer between 1 and 65535`, { field });
  }
  return value as number;
}

function assertSeconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw validationError(`${field} must be a positive, finite number of seconds`, { field });
  }
  return value;
}

function normalizePoolSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DATA_PLANE_POOL_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DATA_PLANE_POOL_SIZE) {
    throw validationError(
      `maxConnections must be an integer between 1 and ${MAX_DATA_PLANE_POOL_SIZE} (received ${String(value)})`,
      { field: 'maxConnections' },
    );
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function normalizeApplicationName(value: unknown): string {
  const name = assertParameter(value, 'applicationName');
  if (hasControlCharacter(name)) {
    throw validationError('applicationName must not contain control characters', {
      field: 'applicationName',
    });
  }
  return name;
}

/**
 * Reads the non-secret coordinates out of a URL. A string that does not parse
 * yields no coordinates rather than an excerpt — an excerpt of a connection
 * string is an excerpt of a credential.
 */
function endpointOfUrl(connectionString: string): { endpoint: DataPlaneEndpoint; secret?: string } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { endpoint: {} };
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const endpoint: DataPlaneEndpoint = {
    ...(url.hostname ? { host: url.hostname } : {}),
    ...(url.port ? { port: Number(url.port) } : {}),
    ...(database ? { database } : {}),
    ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
  };
  const password = url.password ? decodeURIComponent(url.password) : '';
  return password ? { endpoint, secret: password } : { endpoint };
}

function normalizeTarget(target: DataPlaneConnectionTarget): NormalizedTarget {
  if (target === null || typeof target !== 'object') {
    throw validationError('target must describe the database to connect to', { field: 'target' });
  }

  if (isConnectionUrl(target)) {
    const connectionString = assertParameter(target.connectionString, 'target.connectionString');
    const scheme = connectionString.slice(0, connectionString.indexOf(':') + 1);
    if (scheme !== 'postgres:' && scheme !== 'postgresql:') {
      throw validationError('target.connectionString must be a postgres:// or postgresql:// URL', {
        field: 'target.connectionString',
      });
    }
    const databaseOverride =
      target.database === undefined
        ? undefined
        : assertParameter(target.database, 'target.database');
    const { endpoint, secret } = endpointOfUrl(connectionString);
    return {
      kind: 'url',
      endpoint: databaseOverride ? { ...endpoint, database: databaseOverride } : endpoint,
      secrets: secret ? [connectionString, secret] : [connectionString],
      connectionString,
      ...(databaseOverride === undefined ? {} : { databaseOverride }),
    };
  }

  const host = assertParameter(target.host, 'target.host');
  const database = assertParameter(target.database, 'target.database');
  const user = assertParameter(target.user, 'target.user');
  const port = target.port === undefined ? DEFAULT_PORT : assertPort(target.port, 'target.port');
  const password =
    target.password === undefined ? undefined : assertParameter(target.password, 'target.password');
  return {
    kind: 'fields',
    endpoint: { host, port, database, user },
    secrets: password === undefined ? [] : [password],
    host,
    port,
    database,
    user,
    ...(password === undefined ? {} : { password }),
    ...(target.ssl === undefined ? {} : { ssl: target.ssl }),
  };
}

// ── Failure reporting ──

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

/** Replaces every occurrence of every secret, longest first so overlaps are covered. */
function redact(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue;
    scrubbed = scrubbed.split(secret).join(REDACTED);
  }
  return scrubbed;
}

function describeEndpoint(endpoint: DataPlaneEndpoint): string {
  const where = endpoint.host
    ? `${endpoint.host}:${endpoint.port ?? DEFAULT_PORT}`
    : 'the configured host';
  const database = endpoint.database ? `"${endpoint.database}"` : 'the configured database';
  const role = endpoint.user ? ` as role "${endpoint.user}"` : '';
  return `database ${database} on ${where}${role}`;
}

function connectionFailure(
  action: string,
  target: NormalizedTarget,
  error: unknown,
): DataPlaneConnectionError {
  const sqlState = sqlStateOf(error);
  return new DataPlaneConnectionError(
    `Could not ${action} ${describeEndpoint(target.endpoint)}: ${redact(messageOf(error), target.secrets)}`,
    {
      ...target.endpoint,
      ...(sqlState === undefined ? {} : { sqlState }),
    },
  );
}

// ── Opening ──

/**
 * Opens a pooled connection to one database as one role.
 *
 * This is the `connect` step of `createPooledDataPlaneResolver`:
 *
 * ```ts
 * const resolver = createPooledDataPlaneResolver<Placement>({
 *   describe: async (tenantRef) => placements.get(tenantRef),
 *   connect: ({ descriptor }) =>
 *     openDataPlaneConnection({ target: descriptor.connectionInfo, maxConnections: 4 }),
 * });
 * ```
 *
 * Each call owns its pool: nothing is shared between calls, so calling it once
 * per tenant gives every tenant an isolated set of connections that the resolver
 * closes through the returned `close` when it evicts or invalidates the entry.
 *
 * Throws `PlumbusError` (`validation`) for an unusable target or option before
 * any socket is opened, and `DataPlaneConnectionError` when the server refuses
 * or does not answer. Neither carries a password or a connection string.
 */
export async function openDataPlaneConnection(
  options: OpenDataPlaneConnectionOptions,
): Promise<OpenedDataPlaneConnection> {
  const target = normalizeTarget(options.target);
  const max = normalizePoolSize(options.maxConnections);
  const connectTimeout =
    options.connectTimeoutSeconds === undefined
      ? DEFAULT_CONNECT_TIMEOUT_SECONDS
      : assertSeconds(options.connectTimeoutSeconds, 'connectTimeoutSeconds');
  const idleTimeout =
    options.idleTimeoutSeconds === undefined
      ? DEFAULT_IDLE_TIMEOUT_SECONDS
      : assertSeconds(options.idleTimeoutSeconds, 'idleTimeoutSeconds');
  const closeTimeout =
    options.closeTimeoutSeconds === undefined
      ? DEFAULT_CLOSE_TIMEOUT_SECONDS
      : assertSeconds(options.closeTimeoutSeconds, 'closeTimeoutSeconds');
  const maxLifetime =
    options.maxLifetimeSeconds === undefined
      ? undefined
      : assertSeconds(options.maxLifetimeSeconds, 'maxLifetimeSeconds');
  const applicationName =
    options.applicationName === undefined
      ? undefined
      : normalizeApplicationName(options.applicationName);

  const postgresModule = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');

  const shared = {
    max,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    // The server's notice stream can echo statement text; the caller's own
    // logging is the record, not this module's stderr.
    onnotice: () => {},
    ...(maxLifetime === undefined ? {} : { max_lifetime: maxLifetime }),
    ...(applicationName === undefined ? {} : { connection: { application_name: applicationName } }),
  };

  let client: postgres.Sql;
  try {
    client =
      target.kind === 'url'
        ? postgresModule(
            target.connectionString,
            target.databaseOverride === undefined
              ? shared
              : { ...shared, database: target.databaseOverride },
          )
        : postgresModule({
            ...shared,
            host: target.host,
            port: target.port,
            database: target.database,
            username: target.user,
            ...(target.password === undefined ? {} : { password: target.password }),
            ...(target.ssl === undefined ? {} : { ssl: target.ssl }),
          });
  } catch (error) {
    throw connectionFailure('open a connection to', target, error);
  }

  const close = createCloser(client, closeTimeout, target);

  if (options.verify !== false) {
    try {
      await client`SELECT 1`;
    } catch (error) {
      await close().catch(() => undefined);
      throw connectionFailure('open a connection to', target, error);
    }
  }

  return { db: drizzle(client), close };
}

/**
 * Idempotent pool shutdown. Concurrent and repeated calls await the same
 * shutdown; a failed one is not cached, so a later call may try again.
 */
function createCloser(
  client: postgres.Sql,
  timeoutSeconds: number,
  target: NormalizedTarget,
): () => Promise<void> {
  let ending: Promise<void> | undefined;
  return async function close(): Promise<void> {
    ending ??= client.end({ timeout: timeoutSeconds }).then(() => undefined);
    try {
      await ending;
    } catch (error) {
      ending = undefined;
      throw connectionFailure('close the connection to', target, error);
    }
  };
}
