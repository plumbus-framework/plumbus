// Two-database Plan 02 harness against local Postgres (no Docker).
// Creates only plumbus_plan02_* databases and drops them on close.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { assertSafeIdentifier, quoteIdentifier } from '../tenancy/data-plane-provisioning.js';
import {
  eventDeliveryDdl,
  eventOutboxDdl,
  flowExecutionsDdl,
  PLAN02_DB_NAME_PATTERN,
  spineDispatchDdl,
  tenantDurableDdl,
} from './apply-ddl.js';
import { resolveTestPostgresAdmin, type TestPostgresAdmin } from './pg-env.js';

export interface Plan02Harness {
  admin: TestPostgresAdmin;
  spineName: string;
  tenantName: string;
  spineDb: PostgresJsDatabase;
  tenantDb: PostgresJsDatabase;
  coreSchema: string;
  close(): Promise<void>;
}

function adminClient(admin: TestPostgresAdmin, database = admin.database): postgres.Sql {
  return postgres({
    host: admin.host,
    port: admin.port,
    database,
    username: admin.user,
    password: admin.password,
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

async function applyStatements(client: postgres.Sql, ddl: string): Promise<void> {
  for (const statement of ddl
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    await client.unsafe(`${statement};`);
  }
}

async function dropHarnessDatabase(admin: TestPostgresAdmin, name: string): Promise<void> {
  const safe = assertSafeIdentifier(name, 'database', PLAN02_DB_NAME_PATTERN);
  const quoted = quoteIdentifier(safe);
  const client = adminClient(admin);
  try {
    await client.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${safe}' AND pid <> pg_backend_pid()`,
    );
    await client.unsafe(`DROP DATABASE IF EXISTS ${quoted}`);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export async function createPlan02Harness(options?: {
  coreSchema?: string;
  includeFlowExecutions?: boolean;
  includeEventOutbox?: boolean;
  includeEventDelivery?: boolean;
}): Promise<Plan02Harness> {
  const admin = resolveTestPostgresAdmin();
  const suffix = randomBytes(4).toString('hex');
  const spineName = `plumbus_plan02_spine_${suffix}`;
  const tenantName = `plumbus_plan02_tenant_${suffix}`;
  const coreSchema = options?.coreSchema ?? FRAMEWORK_SCHEMA;

  const bootstrap = adminClient(admin);
  try {
    await bootstrap.unsafe(`CREATE DATABASE ${quoteIdentifier(spineName)}`);
    await bootstrap.unsafe(`CREATE DATABASE ${quoteIdentifier(tenantName)}`);
  } finally {
    await bootstrap.end({ timeout: 5 }).catch(() => undefined);
  }

  const spineSql = adminClient(admin, spineName);
  const tenantSql = adminClient(admin, tenantName);
  try {
    await applyStatements(spineSql, spineDispatchDdl());
    await applyStatements(tenantSql, tenantDurableDdl(coreSchema));
    if (options?.includeFlowExecutions !== false) {
      await applyStatements(tenantSql, flowExecutionsDdl());
    }
    if (options?.includeEventOutbox) {
      await applyStatements(tenantSql, eventOutboxDdl());
    }
    if (options?.includeEventDelivery) {
      await applyStatements(tenantSql, eventDeliveryDdl());
    }
  } catch (error) {
    await spineSql.end({ timeout: 5 }).catch(() => undefined);
    await tenantSql.end({ timeout: 5 }).catch(() => undefined);
    await dropHarnessDatabase(admin, spineName);
    await dropHarnessDatabase(admin, tenantName);
    throw error;
  }

  const spineDb = drizzle(spineSql);
  const tenantDb = drizzle(tenantSql);

  return {
    admin,
    spineName,
    tenantName,
    spineDb,
    tenantDb,
    coreSchema,
    async close() {
      await spineSql.end({ timeout: 5 }).catch(() => undefined);
      await tenantSql.end({ timeout: 5 }).catch(() => undefined);
      await dropHarnessDatabase(admin, spineName);
      await dropHarnessDatabase(admin, tenantName);
    },
  };
}

export async function createPlan02Database(options: {
  admin?: TestPostgresAdmin;
  kind: string;
  ddl: string;
}): Promise<{ name: string; db: PostgresJsDatabase; close(): Promise<void> }> {
  const admin = options.admin ?? resolveTestPostgresAdmin();
  const suffix = randomBytes(4).toString('hex');
  const name = `plumbus_plan02_${options.kind}_${suffix}`;
  const safe = assertSafeIdentifier(name, 'database', PLAN02_DB_NAME_PATTERN);
  const bootstrap = adminClient(admin);
  try {
    await bootstrap.unsafe(`CREATE DATABASE ${quoteIdentifier(safe)}`);
  } finally {
    await bootstrap.end({ timeout: 5 }).catch(() => undefined);
  }
  const client = adminClient(admin, safe);
  try {
    if (options.ddl.trim()) {
      await applyStatements(client, options.ddl);
    }
  } catch (error) {
    await client.end({ timeout: 5 }).catch(() => undefined);
    await dropHarnessDatabase(admin, safe);
    throw error;
  }
  return {
    name: safe,
    db: drizzle(client),
    async close() {
      await client.end({ timeout: 5 }).catch(() => undefined);
      await dropHarnessDatabase(admin, safe);
    },
  };
}

export async function extraHarnessConnection(
  admin: TestPostgresAdmin,
  database: string,
): Promise<{ db: PostgresJsDatabase; close(): Promise<void> }> {
  const client = adminClient(admin, database);
  return {
    db: drizzle(client),
    async close() {
      await client.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}
