// ── Tenant Data-Plane Provisioning ──
// Creates and tears down the Postgres data plane that backs a single tenant:
// the database itself, an owner role (used by migrations) and a least-privilege
// runtime role (used at request time). Applications describe the data plane they
// need; the framework performs the DDL. No application should open a raw client
// or issue provisioning DDL of its own.
//
// Every step is idempotent: existing objects are detected up front and the
// duplicate-object SQLSTATEs (42P04 / 42710) are also tolerated so that two
// concurrent provisioners converge on the same outcome. `CREATE DATABASE` and
// `DROP DATABASE` are issued outside any transaction, which Postgres requires.
//
// Key exports: provisionDataPlane, dropDataPlane

import type postgres from 'postgres';
import { PlumbusError } from '../errors/plumbus-error.js';
import type { DatabaseConfig } from '../types/config.js';
import { ErrorCode } from '../types/enums.js';

// ── Errors ──

/** An identifier supplied by a caller is not safe to use as a SQL identifier. */
export class DataPlaneNameError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Validation, message, metadata);
    this.name = 'DataPlaneNameError';
  }
}

/** A destructive operation was refused because it fell outside the caller's guard. */
export class DataPlaneGuardError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Forbidden, message, metadata);
    this.name = 'DataPlaneGuardError';
  }
}

/** A provisioning step failed; `metadata.step` names the step that failed. */
export class DataPlaneProvisioningError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Internal, message, metadata);
    this.name = 'DataPlaneProvisioningError';
  }
}

// ── Identifier safety ──

/**
 * Identifiers are restricted to unquoted-lowercase form. Everything that reaches
 * a SQL string is validated against this first and then double-quoted, so a
 * hostile tenant name can neither terminate the identifier nor fold case.
 */
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** `pg_` is reserved by Postgres for system roles, schemas and namespaces. */
const RESERVED_PREFIX = 'pg_';

/** Encoding / locale names are literals, not identifiers; keep them equally narrow. */
const LOCALE_PATTERN = /^[A-Za-z0-9_.@-]{1,64}$/;

const ALLOWED_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

export type DataPlaneTablePrivilege = (typeof ALLOWED_TABLE_PRIVILEGES)[number];

const DEFAULT_TABLE_PRIVILEGES: DataPlaneTablePrivilege[] = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
];

/** SQLSTATE 42P04 — duplicate_database. */
const DUPLICATE_DATABASE = '42P04';
/** SQLSTATE 42710 — duplicate_object (covers duplicate roles and schemas). */
const DUPLICATE_OBJECT = '42710';

/**
 * Validates a caller-supplied identifier and returns it unchanged.
 *
 * @param extraPattern additional convention the caller requires (e.g. a tenant
 *   database prefix). Applied on top of the framework pattern, never instead of it.
 */
export function assertSafeIdentifier(value: unknown, field: string, extraPattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DataPlaneNameError(`${field} must be a non-empty string`, { field });
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new DataPlaneNameError(
      `${field} "${value}" is not a safe SQL identifier (expected /^[a-z_][a-z0-9_]{0,62}$/)`,
      { field, value },
    );
  }
  if (value.startsWith(RESERVED_PREFIX)) {
    throw new DataPlaneNameError(`${field} "${value}" uses the reserved "pg_" prefix`, {
      field,
      value,
    });
  }
  if (extraPattern && !matchesPattern(extraPattern, value)) {
    throw new DataPlaneNameError(
      `${field} "${value}" does not match the required naming convention ${extraPattern}`,
      { field, value, pattern: extraPattern.source },
    );
  }
  return value;
}

/**
 * Tests a pattern without mutating it. A caller-supplied `/g` or `/y` regex keeps
 * `lastIndex` between calls, which would make a guard pass or fail by turn order.
 */
function matchesPattern(pattern: RegExp, value: string): boolean {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return new RegExp(pattern.source, flags).test(value);
}

/** Double-quotes an already-validated identifier. Defence in depth, not the defence. */
export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function assertLocaleToken(value: string, field: string): string {
  if (!LOCALE_PATTERN.test(value)) {
    throw new DataPlaneNameError(`${field} "${value}" is not a valid ${field} token`, {
      field,
      value,
    });
  }
  return value;
}

function normalizeTablePrivileges(
  privileges: readonly string[] | undefined,
): DataPlaneTablePrivilege[] {
  if (!privileges) return [...DEFAULT_TABLE_PRIVILEGES];
  if (privileges.length === 0) {
    throw new DataPlaneNameError('runtimeTablePrivileges must not be empty');
  }
  return privileges.map((privilege) => {
    const upper = privilege.toUpperCase();
    const match = ALLOWED_TABLE_PRIVILEGES.find((allowed) => allowed === upper);
    if (!match) {
      throw new DataPlaneNameError(`Unsupported table privilege "${privilege}"`, { privilege });
    }
    return match;
  });
}

// ── Connection handling ──

/** Admin credentials with cluster-level rights (CREATEDB + CREATEROLE, or superuser). */
export type DataPlaneAdminConnection = DatabaseConfig | { connectionString: string };

function isConnectionString(
  connection: DataPlaneAdminConnection,
): connection is { connectionString: string } {
  return typeof (connection as { connectionString?: unknown }).connectionString === 'string';
}

interface OpenClientOptions {
  /** Connect to this database instead of the admin connection's own. */
  database?: string;
  connectTimeoutSeconds: number;
}

async function openClient(
  connection: DataPlaneAdminConnection,
  options: OpenClientOptions,
): Promise<postgres.Sql> {
  const postgresModule = (await import('postgres')).default;
  const shared = {
    max: 1,
    connect_timeout: options.connectTimeoutSeconds,
    // Provisioning DDL is chatty ("role ... does not exist, skipping"); the step
    // log is the record, not stderr.
    onnotice: () => {},
  };
  if (isConnectionString(connection)) {
    return postgresModule(
      connection.connectionString,
      options.database ? { ...shared, database: options.database } : shared,
    );
  }
  return postgresModule({
    ...shared,
    host: connection.host,
    port: connection.port,
    database: options.database ?? connection.database,
    username: connection.user,
    password: connection.password,
    ssl: connection.ssl,
  });
}

async function closeClient(client: postgres.Sql): Promise<void> {
  await client.end({ timeout: 5 });
}

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// ── Step log ──

export type DataPlaneStepName =
  | 'create-role'
  | 'alter-role-password'
  | 'grant-role-membership'
  | 'create-database'
  | 'revoke-database-from-public'
  | 'grant-database-connect'
  | 'create-schema'
  | 'revoke-schema-from-public'
  | 'grant-schema-usage'
  | 'grant-table-privileges'
  | 'grant-sequence-privileges'
  | 'set-default-table-privileges'
  | 'set-default-sequence-privileges'
  | 'terminate-connections'
  | 'drop-owned'
  | 'drop-database'
  | 'drop-role';

export type DataPlaneStepOutcome =
  | 'created'
  | 'already-present'
  | 'updated'
  | 'applied'
  | 'dropped'
  | 'absent'
  | 'skipped';

export interface DataPlaneStep {
  step: DataPlaneStepName;
  /** The object the step acted on (database, role or schema name). */
  target: string;
  outcome: DataPlaneStepOutcome;
  /** The SQL that ran, with any password literal redacted. Empty for no-op steps. */
  statement: string;
}

/** Token swapped for the escaped password literal at execution time; what the step log keeps. */
const PASSWORD_SLOT = '__PLUMBUS_PASSWORD_LITERAL__';

async function execute(
  client: postgres.Sql,
  statement: string,
  step: DataPlaneStepName,
  target: string,
): Promise<void> {
  try {
    await client.unsafe(statement);
  } catch (error) {
    throw new DataPlaneProvisioningError(
      `Data-plane step "${step}" failed for "${target}": ${(error as Error).message}`,
      { step, target, sqlState: sqlStateOf(error) },
    );
  }
}

/**
 * Escapes a password on the server with `quote_literal`, so the result honours the
 * connection's `standard_conforming_strings` setting instead of assuming it.
 */
async function quoteLiteral(client: postgres.Sql, value: string): Promise<string> {
  const rows = await client<{ literal: string }[]>`SELECT quote_literal(${value}) AS literal`;
  const literal = rows[0]?.literal;
  if (typeof literal !== 'string') {
    throw new DataPlaneProvisioningError('Server refused to quote a role password');
  }
  return literal;
}

// ── Provisioning ──

export interface DataPlaneRoleSpec {
  name: string;
  /** Omit to create a role without a password (peer/trust or externally managed auth). */
  password?: string;
}

export interface ProvisionDataPlaneOptions {
  /** Credentials able to CREATE DATABASE and CREATE ROLE on the target cluster. */
  adminConnection: DataPlaneAdminConnection;
  /** Database to create. Validated and quoted; never interpolated raw. */
  databaseName: string;
  /** Owns the database and its schemas; the identity migrations run as. */
  ownerRole: string | DataPlaneRoleSpec;
  /** Least-privilege identity for request-time work: DML only, no DDL. */
  runtimeRole: string | DataPlaneRoleSpec;
  /** Extra schemas to create alongside `public`, owned by `ownerRole`. */
  schemas?: readonly string[];
  /** Table privileges granted to the runtime role. Default: SELECT/INSERT/UPDATE/DELETE. */
  runtimeTablePrivileges?: readonly string[];
  /** `CREATE DATABASE ... TEMPLATE`. */
  template?: string;
  /** `CREATE DATABASE ... ENCODING`. */
  encoding?: string;
  /** `CREATE DATABASE ... LC_COLLATE / LC_CTYPE`. */
  locale?: string;
  /** Reset the password of a role that already exists. Default false. */
  updateExistingRolePasswords?: boolean;
  /**
   * Naming convention the database and role names must satisfy, on top of the
   * framework identifier pattern. Schema names are deliberately outside it: they are
   * structural names chosen by the caller's own code (`core_plumbus`, `pkg_*`), not
   * names drawn from a tenant's naming space. They are still validated as identifiers.
   */
  namePattern?: RegExp;
  /** Default 10. */
  connectTimeoutSeconds?: number;
}

export interface DataPlaneProvisionResult {
  databaseName: string;
  ownerRole: string;
  runtimeRole: string;
  /** True when this call created the database, false when it was already present. */
  databaseCreated: boolean;
  rolesCreated: string[];
  rolesAlreadyPresent: string[];
  schemasCreated: string[];
  schemasAlreadyPresent: string[];
  /** Ordered log of every statement issued, for auditing and resumability. */
  steps: DataPlaneStep[];
}

function normalizeRole(
  role: string | DataPlaneRoleSpec,
  field: string,
  namePattern: RegExp | undefined,
): { name: string; password?: string } {
  const spec = typeof role === 'string' ? { name: role } : role;
  const name = assertSafeIdentifier(spec.name, field, namePattern);
  if (spec.password !== undefined) {
    if (typeof spec.password !== 'string' || spec.password.length === 0) {
      throw new DataPlaneNameError(`${field}.password must be a non-empty string when provided`, {
        field,
      });
    }
    if (spec.password.includes('\u0000')) {
      throw new DataPlaneNameError(`${field}.password must not contain a NUL character`, { field });
    }
    return { name, password: spec.password };
  }
  return { name };
}

/**
 * Creates a tenant's data plane, idempotently.
 *
 * Performs, in order: owner and runtime roles, admin membership of the owner role
 * (required to set the database owner and default privileges when the admin is not
 * a superuser), `CREATE DATABASE` outside a transaction, database-level revocation
 * of PUBLIC, then per-schema grants and default privileges inside the new database.
 *
 * Safe to re-run after a partial failure: each step reports `created` or
 * `already-present`, so a caller can resume without special-casing.
 */
export async function provisionDataPlane(
  options: ProvisionDataPlaneOptions,
): Promise<DataPlaneProvisionResult> {
  const namePattern = options.namePattern;
  const databaseName = assertSafeIdentifier(options.databaseName, 'databaseName', namePattern);
  const owner = normalizeRole(options.ownerRole, 'ownerRole', namePattern);
  const runtime = normalizeRole(options.runtimeRole, 'runtimeRole', namePattern);
  if (owner.name === runtime.name) {
    throw new DataPlaneNameError(
      `ownerRole and runtimeRole must differ (both "${owner.name}"); the runtime role exists to hold fewer privileges than the owner`,
      { ownerRole: owner.name, runtimeRole: runtime.name },
    );
  }
  const extraSchemas = (options.schemas ?? []).map((schema) =>
    assertSafeIdentifier(schema, 'schema'),
  );
  const tablePrivileges = normalizeTablePrivileges(options.runtimeTablePrivileges);
  const template = options.template
    ? assertSafeIdentifier(options.template, 'template')
    : undefined;
  const encoding = options.encoding ? assertLocaleToken(options.encoding, 'encoding') : undefined;
  const locale = options.locale ? assertLocaleToken(options.locale, 'locale') : undefined;
  const connectTimeoutSeconds = options.connectTimeoutSeconds ?? 10;

  const steps: DataPlaneStep[] = [];
  const rolesCreated: string[] = [];
  const rolesAlreadyPresent: string[] = [];
  const schemasCreated: string[] = [];
  const schemasAlreadyPresent: string[] = [];
  let databaseCreated = false;

  const admin = await openClient(options.adminConnection, { connectTimeoutSeconds });
  try {
    for (const role of [owner, runtime]) {
      const created = await ensureRole(admin, role, steps, {
        updatePassword: options.updateExistingRolePasswords === true,
      });
      (created ? rolesCreated : rolesAlreadyPresent).push(role.name);
    }

    await ensureAdminMembership(admin, owner.name, steps);
    databaseCreated = await ensureDatabase(admin, databaseName, owner.name, steps, {
      template,
      encoding,
      locale,
    });
    await applyDatabaseGrants(admin, databaseName, owner.name, runtime.name, steps);
  } finally {
    await closeClient(admin);
  }

  const target = await openClient(options.adminConnection, {
    database: databaseName,
    connectTimeoutSeconds,
  });
  try {
    for (const schema of ['public', ...extraSchemas]) {
      if (schema !== 'public') {
        const created = await ensureSchema(target, schema, owner.name, steps);
        (created ? schemasCreated : schemasAlreadyPresent).push(schema);
      }
      await applySchemaGrants(target, schema, owner.name, runtime.name, tablePrivileges, steps);
    }
  } finally {
    await closeClient(target);
  }

  return {
    databaseName,
    ownerRole: owner.name,
    runtimeRole: runtime.name,
    databaseCreated,
    rolesCreated,
    rolesAlreadyPresent,
    schemasCreated,
    schemasAlreadyPresent,
    steps,
  };
}

async function roleExists(client: postgres.Sql, name: string): Promise<boolean> {
  const rows = await client<{ one: number }[]>`
    SELECT 1 AS one FROM pg_catalog.pg_roles WHERE rolname = ${name}
  `;
  return rows.length > 0;
}

async function ensureRole(
  client: postgres.Sql,
  role: { name: string; password?: string },
  steps: DataPlaneStep[],
  options: { updatePassword: boolean },
): Promise<boolean> {
  const quoted = quoteIdentifier(role.name);
  const exists = await roleExists(client, role.name);

  if (exists) {
    steps.push({
      step: 'create-role',
      target: role.name,
      outcome: 'already-present',
      statement: '',
    });
    if (options.updatePassword && role.password !== undefined) {
      const literal = await quoteLiteral(client, role.password);
      await execute(
        client,
        `ALTER ROLE ${quoted} WITH LOGIN PASSWORD ${literal}`,
        'alter-role-password',
        role.name,
      );
      steps.push({
        step: 'alter-role-password',
        target: role.name,
        outcome: 'updated',
        statement: `ALTER ROLE ${quoted} WITH LOGIN PASSWORD ${PASSWORD_SLOT}`,
      });
    }
    return false;
  }

  const attributes = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  const redacted = `CREATE ROLE ${quoted} WITH ${attributes}${
    role.password === undefined ? '' : ` PASSWORD ${PASSWORD_SLOT}`
  }`;
  const literal =
    role.password === undefined ? undefined : await quoteLiteral(client, role.password);
  // A function replacer, never a string one: `$&`, `$'` and friends inside a
  // password are String.replace substitution patterns and would otherwise be
  // expanded into the statement.
  const statement =
    literal === undefined ? redacted : redacted.replace(PASSWORD_SLOT, () => literal);

  try {
    await client.unsafe(statement);
  } catch (error) {
    // Another provisioner won the race between the existence check and the create.
    if (sqlStateOf(error) === DUPLICATE_OBJECT) {
      steps.push({
        step: 'create-role',
        target: role.name,
        outcome: 'already-present',
        statement: '',
      });
      return false;
    }
    throw new DataPlaneProvisioningError(
      `Data-plane step "create-role" failed for "${role.name}": ${(error as Error).message}`,
      { step: 'create-role', target: role.name, sqlState: sqlStateOf(error) },
    );
  }

  steps.push({
    step: 'create-role',
    target: role.name,
    outcome: 'created',
    statement: redacted,
  });
  return true;
}

/**
 * `CREATE DATABASE ... OWNER x`, `ALTER DEFAULT PRIVILEGES FOR ROLE x` and granting
 * inside a schema owned by x all require the admin to be a member of x. Superusers
 * already satisfy `pg_has_role`; a CREATEROLE admin gains membership here.
 */
async function ensureAdminMembership(
  client: postgres.Sql,
  ownerRole: string,
  steps: DataPlaneStep[],
): Promise<void> {
  const rows = await client<{ member: boolean; admin_name: string; admin_quoted: string }[]>`
    SELECT pg_catalog.pg_has_role(CURRENT_USER, ${ownerRole}, 'USAGE') AS member,
           CURRENT_USER::text AS admin_name,
           pg_catalog.quote_ident(CURRENT_USER::text) AS admin_quoted
  `;
  const row = rows[0];
  if (!row) {
    throw new DataPlaneProvisioningError('Could not determine the admin role membership');
  }
  if (row.member) {
    steps.push({
      step: 'grant-role-membership',
      target: ownerRole,
      outcome: 'already-present',
      statement: '',
    });
    return;
  }
  const statement = `GRANT ${quoteIdentifier(ownerRole)} TO ${row.admin_quoted}`;
  await execute(client, statement, 'grant-role-membership', ownerRole);
  steps.push({
    step: 'grant-role-membership',
    target: ownerRole,
    outcome: 'applied',
    statement,
  });
}

async function databaseExists(client: postgres.Sql, name: string): Promise<boolean> {
  const rows = await client<{ one: number }[]>`
    SELECT 1 AS one FROM pg_catalog.pg_database WHERE datname = ${name}
  `;
  return rows.length > 0;
}

async function ensureDatabase(
  client: postgres.Sql,
  databaseName: string,
  ownerRole: string,
  steps: DataPlaneStep[],
  options: { template?: string; encoding?: string; locale?: string },
): Promise<boolean> {
  if (await databaseExists(client, databaseName)) {
    steps.push({
      step: 'create-database',
      target: databaseName,
      outcome: 'already-present',
      statement: '',
    });
    return false;
  }

  // Postgres forbids CREATE DATABASE inside a transaction block; this client runs
  // in autocommit and the statement is issued on its own.
  const clauses = [`OWNER ${quoteIdentifier(ownerRole)}`];
  if (options.template) clauses.push(`TEMPLATE ${quoteIdentifier(options.template)}`);
  if (options.encoding) clauses.push(`ENCODING '${options.encoding}'`);
  if (options.locale) {
    clauses.push(`LC_COLLATE '${options.locale}'`, `LC_CTYPE '${options.locale}'`);
  }
  const statement = `CREATE DATABASE ${quoteIdentifier(databaseName)} ${clauses.join(' ')}`;

  try {
    await client.unsafe(statement);
  } catch (error) {
    if (sqlStateOf(error) === DUPLICATE_DATABASE) {
      steps.push({
        step: 'create-database',
        target: databaseName,
        outcome: 'already-present',
        statement: '',
      });
      return false;
    }
    throw new DataPlaneProvisioningError(
      `Data-plane step "create-database" failed for "${databaseName}": ${(error as Error).message}`,
      { step: 'create-database', target: databaseName, sqlState: sqlStateOf(error) },
    );
  }

  steps.push({
    step: 'create-database',
    target: databaseName,
    outcome: 'created',
    statement,
  });
  return true;
}

async function applyDatabaseGrants(
  client: postgres.Sql,
  databaseName: string,
  ownerRole: string,
  runtimeRole: string,
  steps: DataPlaneStep[],
): Promise<void> {
  const db = quoteIdentifier(databaseName);

  const revoke = `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`;
  await execute(client, revoke, 'revoke-database-from-public', databaseName);
  steps.push({
    step: 'revoke-database-from-public',
    target: databaseName,
    outcome: 'applied',
    statement: revoke,
  });

  const grantOwner = `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${quoteIdentifier(ownerRole)}`;
  await execute(client, grantOwner, 'grant-database-connect', ownerRole);
  steps.push({
    step: 'grant-database-connect',
    target: ownerRole,
    outcome: 'applied',
    statement: grantOwner,
  });

  const grantRuntime = `GRANT CONNECT ON DATABASE ${db} TO ${quoteIdentifier(runtimeRole)}`;
  await execute(client, grantRuntime, 'grant-database-connect', runtimeRole);
  steps.push({
    step: 'grant-database-connect',
    target: runtimeRole,
    outcome: 'applied',
    statement: grantRuntime,
  });
}

async function ensureSchema(
  client: postgres.Sql,
  schema: string,
  ownerRole: string,
  steps: DataPlaneStep[],
): Promise<boolean> {
  const rows = await client<{ one: number }[]>`
    SELECT 1 AS one FROM pg_catalog.pg_namespace WHERE nspname = ${schema}
  `;
  if (rows.length > 0) {
    steps.push({
      step: 'create-schema',
      target: schema,
      outcome: 'already-present',
      statement: '',
    });
    return false;
  }

  const statement = `CREATE SCHEMA ${quoteIdentifier(schema)} AUTHORIZATION ${quoteIdentifier(ownerRole)}`;
  try {
    await client.unsafe(statement);
  } catch (error) {
    if (sqlStateOf(error) === DUPLICATE_OBJECT) {
      steps.push({
        step: 'create-schema',
        target: schema,
        outcome: 'already-present',
        statement: '',
      });
      return false;
    }
    throw new DataPlaneProvisioningError(
      `Data-plane step "create-schema" failed for "${schema}": ${(error as Error).message}`,
      { step: 'create-schema', target: schema, sqlState: sqlStateOf(error) },
    );
  }

  steps.push({ step: 'create-schema', target: schema, outcome: 'created', statement });
  return true;
}

async function applySchemaGrants(
  client: postgres.Sql,
  schema: string,
  ownerRole: string,
  runtimeRole: string,
  tablePrivileges: readonly DataPlaneTablePrivilege[],
  steps: DataPlaneStep[],
): Promise<void> {
  const ns = quoteIdentifier(schema);
  const owner = quoteIdentifier(ownerRole);
  const runtime = quoteIdentifier(runtimeRole);
  const privileges = tablePrivileges.join(', ');

  const statements: { step: DataPlaneStepName; target: string; sql: string }[] = [
    // On Postgres < 15 PUBLIC holds CREATE on `public`; on any version it holds
    // USAGE. Both are removed before anything is granted back explicitly.
    {
      step: 'revoke-schema-from-public',
      target: schema,
      sql: `REVOKE ALL ON SCHEMA ${ns} FROM PUBLIC`,
    },
    {
      step: 'grant-schema-usage',
      target: ownerRole,
      sql: `GRANT USAGE, CREATE ON SCHEMA ${ns} TO ${owner}`,
    },
    // The runtime role gets USAGE only: it may reach objects in the schema but
    // may not create them. DDL stays with the owner role that migrations use.
    {
      step: 'grant-schema-usage',
      target: runtimeRole,
      sql: `GRANT USAGE ON SCHEMA ${ns} TO ${runtime}`,
    },
    {
      step: 'grant-table-privileges',
      target: runtimeRole,
      sql: `GRANT ${privileges} ON ALL TABLES IN SCHEMA ${ns} TO ${runtime}`,
    },
    {
      step: 'grant-sequence-privileges',
      target: runtimeRole,
      sql: `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${ns} TO ${runtime}`,
    },
    // Objects a later migration creates as the owner are covered without re-running
    // provisioning.
    {
      step: 'set-default-table-privileges',
      target: runtimeRole,
      sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${ns} GRANT ${privileges} ON TABLES TO ${runtime}`,
    },
    {
      step: 'set-default-sequence-privileges',
      target: runtimeRole,
      sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${ns} GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`,
    },
  ];

  for (const entry of statements) {
    await execute(client, entry.sql, entry.step, entry.target);
    steps.push({
      step: entry.step,
      target: entry.target,
      outcome: 'applied',
      statement: entry.sql,
    });
  }
}

// ── Teardown ──

export interface DropDataPlaneOptions {
  adminConnection: DataPlaneAdminConnection;
  databaseName: string;
  /**
   * Required guard. The database and every role named here must match this
   * caller-supplied convention or nothing is dropped. There is no default: a
   * teardown primitive without an explicit blast radius is not safe to ship.
   */
  allowedNamePattern: RegExp;
  /** Roles to drop after the database. Each must match `allowedNamePattern`. */
  roles?: readonly string[];
  /** Terminate sessions still attached to the database. Default true. */
  terminateConnections?: boolean;
  /** Default 10. */
  connectTimeoutSeconds?: number;
}

export interface DataPlaneDropResult {
  databaseName: string;
  /** True when this call dropped the database, false when it was already gone. */
  databaseDropped: boolean;
  rolesDropped: string[];
  rolesAbsent: string[];
  terminatedConnections: number;
  steps: DataPlaneStep[];
}

/**
 * Drops a tenant's data plane — intended for test and fixture tenants.
 *
 * Refuses any database or role name that does not match `allowedNamePattern`, and
 * refuses to drop the database the admin connection is itself using. Idempotent:
 * a second call reports `absent` rather than failing.
 */
export async function dropDataPlane(options: DropDataPlaneOptions): Promise<DataPlaneDropResult> {
  if (!(options.allowedNamePattern instanceof RegExp)) {
    throw new DataPlaneGuardError(
      'allowedNamePattern is required: dropDataPlane will not drop anything without an explicit naming convention',
    );
  }
  const databaseName = assertSafeIdentifier(options.databaseName, 'databaseName');
  if (!matchesPattern(options.allowedNamePattern, databaseName)) {
    throw new DataPlaneGuardError(
      `Refusing to drop database "${databaseName}": it does not match ${options.allowedNamePattern}`,
      { databaseName, pattern: options.allowedNamePattern.source },
    );
  }
  const roles = (options.roles ?? []).map((role) => {
    const name = assertSafeIdentifier(role, 'role');
    if (!matchesPattern(options.allowedNamePattern, name)) {
      throw new DataPlaneGuardError(
        `Refusing to drop role "${name}": it does not match ${options.allowedNamePattern}`,
        { role: name, pattern: options.allowedNamePattern.source },
      );
    }
    return name;
  });

  const connectTimeoutSeconds = options.connectTimeoutSeconds ?? 10;
  const steps: DataPlaneStep[] = [];
  const rolesDropped: string[] = [];
  const rolesAbsent: string[] = [];
  let databaseDropped = false;
  let terminatedConnections = 0;

  const admin = await openClient(options.adminConnection, { connectTimeoutSeconds });
  try {
    const currentRows = await admin<{ current: string }[]>`
      SELECT current_database()::text AS current
    `;
    if (currentRows[0]?.current === databaseName) {
      throw new DataPlaneGuardError(
        `Refusing to drop database "${databaseName}": it is the admin connection's own database`,
        { databaseName },
      );
    }

    const exists = await databaseExists(admin, databaseName);
    if (exists) {
      if (options.terminateConnections !== false) {
        const terminated = await admin<{ pid: number }[]>`
          SELECT pg_catalog.pg_terminate_backend(pid) AS ok, pid
          FROM pg_catalog.pg_stat_activity
          WHERE datname = ${databaseName} AND pid <> pg_catalog.pg_backend_pid()
        `;
        terminatedConnections = terminated.length;
        steps.push({
          step: 'terminate-connections',
          target: databaseName,
          outcome: terminatedConnections > 0 ? 'applied' : 'skipped',
          statement: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        });
      }

      // DROP DATABASE, like CREATE DATABASE, cannot run inside a transaction block.
      const statement = `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`;
      await execute(admin, statement, 'drop-database', databaseName);
      databaseDropped = true;
      steps.push({
        step: 'drop-database',
        target: databaseName,
        outcome: 'dropped',
        statement,
      });
    } else {
      steps.push({
        step: 'drop-database',
        target: databaseName,
        outcome: 'absent',
        statement: '',
      });
    }

    for (const role of roles) {
      if (!(await roleExists(admin, role))) {
        rolesAbsent.push(role);
        steps.push({ step: 'drop-role', target: role, outcome: 'absent', statement: '' });
        continue;
      }
      // Clears privileges the role still holds in the admin database; the tenant
      // database's own objects went with the DROP DATABASE above.
      const dropOwned = `DROP OWNED BY ${quoteIdentifier(role)}`;
      await execute(admin, dropOwned, 'drop-owned', role);
      steps.push({ step: 'drop-owned', target: role, outcome: 'applied', statement: dropOwned });

      const dropRole = `DROP ROLE IF EXISTS ${quoteIdentifier(role)}`;
      await execute(admin, dropRole, 'drop-role', role);
      rolesDropped.push(role);
      steps.push({ step: 'drop-role', target: role, outcome: 'dropped', statement: dropRole });
    }
  } finally {
    await closeClient(admin);
  }

  return {
    databaseName,
    databaseDropped,
    rolesDropped,
    rolesAbsent,
    terminatedConnections,
    steps,
  };
}
