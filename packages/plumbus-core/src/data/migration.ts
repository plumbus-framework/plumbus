import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { getTableName, is } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { documentChunksTable, documentsTable } from '../ai/rag/schema.js';
import { auditRecords } from '../audit/schema.js';
import { createTenantApprovalTables } from '../approvals/schema.js';
import { createTenantDurableTables } from '../durable/schema.js';
import { deadLetterTable, idempotencyTable, outboxTable } from '../events/outbox.js';
import { flowDeadLetterTable, flowExecutionsTable, flowSchedulesTable } from '../flows/schema.js';
import { jobExecutionsTable } from '../jobs/schema.js';
import type { EntityDefinition } from '../types/entity.js';
import { FRAMEWORK_SCHEMA, generateDrizzleSchema } from './schema-generator.js';

export interface MigrationConfig {
  db: PostgresJsDatabase;
  migrationsFolder: string;
}

// ── Pending Migration Reader ──

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface PendingMigration {
  tag: string;
  hash: string;
  statements: string[];
  rawSql: string;
  folderMillis: number;
}

export interface MigrationApplyResult {
  applied: number;
  tags: string[];
}

export interface MigrationReconcileResult {
  adopted: number;
  alreadyApplied: number;
  adoptedTags: string[];
}

function readMigrationJournalEntries(migrationsFolder: string): JournalEntry[] {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Can't find meta/_journal.json in ${migrationsFolder}`);
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
    entries: JournalEntry[];
  };

  return journal.entries;
}

function readJournalMigrations(migrationsFolder: string): PendingMigration[] {
  const journalEntries = readMigrationJournalEntries(migrationsFolder);

  return journalEntries.map((entry) => {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Missing migration file: ${sqlPath}`);
    }

    const rawSql = fs.readFileSync(sqlPath, 'utf-8');
    const hash = crypto.createHash('sha256').update(rawSql).digest('hex');
    const statements = entry.breakpoints
      ? rawSql
          .split('--> statement-breakpoint')
          .map((statement) => statement.trim())
          .filter(Boolean)
      : [rawSql];

    return {
      tag: entry.tag,
      hash,
      statements,
      rawSql,
      folderMillis: entry.when,
    };
  });
}

async function ensureMigrationsTable(db: PostgresJsDatabase): Promise<void> {
  // Keep tracking metadata in the `drizzle` schema (stock Drizzle's default)
  // so it stays out of `public` and the location is deterministic across
  // sessions regardless of search_path.
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )`,
  );
  await adoptLegacyPublicMigrationHistory(db);
}

/**
 * Copy migration history from the legacy `public.__drizzle_migrations` table
 * when projects move tracking into the `drizzle` schema. Idempotent: only
 * inserts hashes that are not already recorded.
 *
 * The legacy table is checked in application code first — PostgreSQL still
 * errors on `FROM public.__drizzle_migrations` when the relation is missing,
 * even if the statement includes an `information_schema` guard.
 */
async function legacyPublicMigrationsTableExists(db: PostgresJsDatabase): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '__drizzle_migrations'
    LIMIT 1
  `)) as unknown as unknown[];

  return rows.length > 0;
}

async function adoptLegacyPublicMigrationHistory(db: PostgresJsDatabase): Promise<void> {
  if (!(await legacyPublicMigrationsTableExists(db))) {
    return;
  }

  await db.execute(sql`
    INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
    SELECT legacy.hash, legacy.created_at
    FROM "public"."__drizzle_migrations" AS legacy
    WHERE NOT EXISTS (
      SELECT 1
      FROM "drizzle"."__drizzle_migrations" AS current
      WHERE current.hash = legacy.hash
    )
  `);
}

async function getAppliedMigrationHashes(db: PostgresJsDatabase): Promise<Set<string>> {
  const appliedRows = (await db.execute(
    sql`SELECT hash FROM "drizzle"."__drizzle_migrations"`,
  )) as unknown as Array<{ hash: string }>;

  return new Set(appliedRows.map((row) => row.hash));
}

/**
 * Read the migration journal and determine which migrations are pending
 * (not yet applied to the database).
 */
export async function readPendingMigrations(config: MigrationConfig): Promise<PendingMigration[]> {
  const { db, migrationsFolder } = config;

  await ensureMigrationsTable(db);

  const appliedHashes = await getAppliedMigrationHashes(db);
  const journalMigrations = readJournalMigrations(migrationsFolder);

  return journalMigrations.filter((migration) => !appliedHashes.has(migration.hash));
}

/**
 * Apply pending migrations from the migrations folder.
 *
 * Each migration runs inside a transaction. On failure, the error includes
 * the migration tag, statement index, and a SQL preview for diagnostics.
 */
export async function applyMigrations(config: MigrationConfig): Promise<MigrationApplyResult> {
  const pending = await readPendingMigrations(config);

  if (pending.length === 0) {
    return { applied: 0, tags: [] };
  }

  const appliedTags: string[] = [];
  for (const migration of pending) {
    await config.db.transaction(async (tx) => {
      for (let i = 0; i < migration.statements.length; i++) {
        const stmt = migration.statements[i] ?? '';
        try {
          await tx.execute(sql.raw(stmt));
        } catch (stmtErr) {
          const preview = stmt.length > 200 ? `${stmt.slice(0, 200)}...` : stmt;
          throw new Error(
            `Migration "${migration.tag}" failed at statement ${i + 1}/${migration.statements.length}:\n` +
              `  SQL: ${preview}\n` +
              `  Error: ${stmtErr instanceof Error ? stmtErr.message : String(stmtErr)}`,
          );
        }
      }
      await tx.execute(
        sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`,
      );
    });
    appliedTags.push(migration.tag);
  }

  return { applied: appliedTags.length, tags: appliedTags };
}

/**
 * Reconcile migration history by marking journal migrations as applied
 * without executing schema changes. Intended for adoption/recovery when
 * the live database already matches the current Plumbus schema.
 */
export async function reconcileMigrationHistory(
  config: MigrationConfig,
): Promise<MigrationReconcileResult> {
  const journalMigrations = readJournalMigrations(config.migrationsFolder);

  await ensureMigrationsTable(config.db);
  const appliedHashes = await getAppliedMigrationHashes(config.db);
  const missingMigrations = journalMigrations.filter(
    (migration) => !appliedHashes.has(migration.hash),
  );

  if (missingMigrations.length === 0) {
    return {
      adopted: 0,
      alreadyApplied: journalMigrations.length,
      adoptedTags: [],
    };
  }

  await config.db.transaction(async (tx) => {
    for (const migration of missingMigrations) {
      await tx.execute(
        sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
            VALUES (${migration.hash}, ${migration.folderMillis})`,
      );
    }
  });

  return {
    adopted: missingMigrations.length,
    alreadyApplied: journalMigrations.length - missingMigrations.length,
    adoptedTags: missingMigrations.map((migration) => migration.tag),
  };
}

/**
 * Collect all Drizzle table schemas from entity definitions,
 * plus framework-internal tables (e.g. audit_records).
 * Used by drizzle-kit config to introspect the schema for migration generation.
 */
export function collectSchemas(
  entities: EntityDefinition[],
  extraSchemas?: Record<string, unknown>,
): Record<string, PgTableWithColumns<any>> {
  const schemas: Record<string, PgTableWithColumns<any>> = {};
  const tableNames = new Set<string>();

  for (const entity of entities) {
    const table = generateDrizzleSchema(entity);
    schemas[entity.name] = table;
    tableNames.add(getTableName(table));
  }
  // Framework-internal tables
  schemas.__audit_records = auditRecords as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(auditRecords));
  // Event outbox tables
  schemas.__event_outbox = outboxTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(outboxTable));
  schemas.__event_idempotency = idempotencyTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(idempotencyTable));
  schemas.__event_dead_letter = deadLetterTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(deadLetterTable));
  // Flow tables
  schemas.__flow_executions = flowExecutionsTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(flowExecutionsTable));
  schemas.__flow_dead_letter = flowDeadLetterTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(flowDeadLetterTable));
  schemas.__flow_schedules = flowSchedulesTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(flowSchedulesTable));
  schemas.__job_executions = jobExecutionsTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(jobExecutionsTable));
  // Protocol A tenant durable tables (core_plumbus)
  const durable = createTenantDurableTables(FRAMEWORK_SCHEMA);
  schemas.__execution_state = durable.executionState as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(durable.executionState));
  schemas.__step_execution = durable.stepExecution as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(durable.stepExecution));
  schemas.__wait_state = durable.waitState as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(durable.waitState));
  schemas.__terminal_state = durable.terminalState as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(durable.terminalState));
  schemas.__dispatch_outbox = durable.dispatchOutbox as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(durable.dispatchOutbox));
  schemas.__side_effect_log = durable.sideEffectLog as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(durable.sideEffectLog));
  // Human-task / approval tables (core_plumbus)
  const approvals = createTenantApprovalTables(FRAMEWORK_SCHEMA);
  schemas.__human_task = approvals.humanTask as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(approvals.humanTask));
  schemas.__approval_request = approvals.approvalRequest as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(approvals.approvalRequest));
  schemas.__approval_decision = approvals.approvalDecision as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(approvals.approvalDecision));
  // RAG tables
  schemas.__documents = documentsTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(documentsTable));
  schemas.__document_chunks = documentChunksTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(documentChunksTable));

  if (extraSchemas) {
    for (const [snapshotKey, table] of Object.entries(extraSchemas)) {
      if (!is(table, PgTable)) {
        continue;
      }
      const pgTable = table as PgTableWithColumns<any>;
      const tableName = getTableName(pgTable);
      if (tableNames.has(tableName)) {
        throw new Error(
          `Migration schema collision: table '${tableName}' is defined by both framework/entity schemas and extra schema '${snapshotKey}'`,
        );
      }
      schemas[`ext_${snapshotKey}`] = pgTable;
      tableNames.add(tableName);
    }
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

export interface MigrationRollbackResult {
  /** Journal tag when it resolves, otherwise the recorded hash. Null when nothing was rolled back. */
  rolledBack: string | null;
  /** sha256 of the migration SQL, as recorded in the history table. */
  hash: string | null;
  /** Journal tag for `hash`, or null when the migration file is no longer present. */
  tag: string | null;
  status: 'rolled_back' | 'no_migrations';
}

/**
 * Best-effort lookup of the journal tag for an applied migration hash.
 * Returns null when the journal or the SQL file is gone — history rows outlive
 * the files that produced them, and that must not fail the rollback.
 */
function findJournalTagForHash(migrationsFolder: string, hash: string): string | null {
  try {
    return (
      readJournalMigrations(migrationsFolder).find((entry) => entry.hash === hash)?.tag ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Roll back the last applied migration by deleting its row from the migration
 * history table, so `applyMigrations` treats it as pending again.
 *
 * This does **not** execute reverse DDL: Drizzle generates no down-migrations,
 * so tables, columns, and indexes the migration created stay in place. Drop or
 * restore those manually when the schema itself has to change.
 *
 * For safety, rollback is limited to one migration at a time.
 */
export async function rollbackLastMigration(
  config: MigrationConfig,
): Promise<MigrationRollbackResult> {
  const { db, migrationsFolder } = config;

  // Creates the history table when absent, so a database that has never been
  // migrated reports `no_migrations` instead of erroring on a missing relation.
  await ensureMigrationsTable(db);

  const rows = (await db.execute(
    sql`SELECT id, hash FROM "drizzle"."__drizzle_migrations"
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 1`,
  )) as unknown as Array<{ id: number; hash: string }>;

  const lastMigration = rows[0];
  if (!lastMigration) {
    return { rolledBack: null, hash: null, tag: null, status: 'no_migrations' };
  }

  // Delete by id, not hash — a hash can legitimately repeat across rows and
  // must not take unrelated history with it.
  await db.execute(
    sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE id = ${lastMigration.id}`,
  );

  const tag = findJournalTagForHash(migrationsFolder, lastMigration.hash);

  return {
    rolledBack: tag ?? lastMigration.hash,
    hash: lastMigration.hash,
    tag,
    status: 'rolled_back',
  };
}
