// ── Schema Drift Inspector ──
// Detects drift between the live PostgreSQL database and the expected
// Drizzle schema definitions for framework-managed tables. Used by
// `migrate apply` and `migrate push` to fail fast when manually-created
// tables conflict with the framework schema.

import { getTableColumns, sql } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { EntityDefinition } from '../types/entity.js';
import { collectSchemas } from './migration.js';

/** Framework-managed table names (actual DB names). */
export const FRAMEWORK_TABLE_NAMES = [
  'audit_records',
  'event_outbox',
  'event_idempotency',
  'event_dead_letter',
  'flow_executions',
  'flow_dead_letter',
  'flow_schedules',
  'job_executions',
  'documents',
  'document_chunks',
  'execution_state',
  'step_execution',
  'wait_state',
  'terminal_state',
  'dispatch_outbox',
  'side_effect_log',
  'human_task',
  'approval_request',
  'approval_decision',
] as const;

export type FrameworkTableName = (typeof FRAMEWORK_TABLE_NAMES)[number];

// ── Drift Report Types ──

export interface ColumnDrift {
  column: string;
  kind: 'missing_in_db' | 'extra_in_db' | 'type_mismatch' | 'nullability_mismatch';
  expected?: string;
  actual?: string;
}

export interface TableDrift {
  tableName: string;
  exists: boolean;
  columnDrifts: ColumnDrift[];
}

export interface DriftReport {
  hasDrift: boolean;
  existingFrameworkTables: string[];
  missingFrameworkTables: string[];
  tables: TableDrift[];
}

// ── Type Normalization ──

/**
 * Normalize PostgreSQL type names for consistent comparison between
 * format_type() output and Drizzle's getSQLType().
 */
function normalizeType(t: string): string {
  return t
    .replace(/character varying/g, 'varchar')
    .replace(/timestamp without time zone/g, 'timestamp')
    .trim()
    .toLowerCase();
}

// ── Live DB Introspection ──

interface LiveColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
}

/**
 * Get the set of table names that exist in the live database.
 */
async function getLiveTables(db: PostgresJsDatabase, schema = 'public'): Promise<Set<string>> {
  const rows = (await db.execute(
    sql`SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'`,
  )) as unknown as Array<{ table_name: string }>;
  return new Set(rows.map((r) => r.table_name));
}

/**
 * Get column metadata for a table from the live database.
 * Uses pg_catalog with format_type() for accurate type strings.
 */
async function getLiveColumns(
  db: PostgresJsDatabase,
  tableName: string,
  schema = 'public',
): Promise<LiveColumn[]> {
  const rows = (await db.execute(
    sql`SELECT
          a.attname AS column_name,
          format_type(a.atttypid, a.atttypmod) AS data_type,
          NOT a.attnotnull AS is_nullable
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relname = ${tableName}
          AND n.nspname = ${schema}
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum`,
  )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: boolean }>;
  return rows.map((r) => ({
    name: r.column_name,
    dataType: normalizeType(r.data_type),
    isNullable: r.is_nullable,
  }));
}

// ── Expected Schema Extraction ──

interface ExpectedColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
}

function getExpectedColumns(table: PgTableWithColumns<any>): ExpectedColumn[] {
  const columns = getTableColumns(table);
  return Object.values(columns).map((col: any) => ({
    name: col.name as string,
    dataType: normalizeType(col.getSQLType() as string),
    isNullable: !(col.notNull as boolean),
  }));
}

// ── Comparison ──

function compareTable(
  tableName: string,
  expected: ExpectedColumn[],
  live: LiveColumn[],
): TableDrift {
  const drifts: ColumnDrift[] = [];
  const liveMap = new Map(live.map((c) => [c.name, c]));
  const expectedMap = new Map(expected.map((c) => [c.name, c]));

  for (const exp of expected) {
    const liveCol = liveMap.get(exp.name);
    if (!liveCol) {
      drifts.push({ column: exp.name, kind: 'missing_in_db', expected: exp.dataType });
      continue;
    }
    if (exp.dataType !== liveCol.dataType) {
      drifts.push({
        column: exp.name,
        kind: 'type_mismatch',
        expected: exp.dataType,
        actual: liveCol.dataType,
      });
    }
    if (exp.isNullable !== liveCol.isNullable) {
      drifts.push({
        column: exp.name,
        kind: 'nullability_mismatch',
        expected: exp.isNullable ? 'nullable' : 'not null',
        actual: liveCol.isNullable ? 'nullable' : 'not null',
      });
    }
  }

  for (const liveCol of live) {
    if (!expectedMap.has(liveCol.name)) {
      drifts.push({ column: liveCol.name, kind: 'extra_in_db', actual: liveCol.dataType });
    }
  }

  return { tableName, exists: true, columnDrifts: drifts };
}

// ── Public API ──

/**
 * Check which framework-managed tables currently exist in the live database.
 */
function drizzleTableSchema(table: PgTableWithColumns<any>): string {
  return getTableConfig(table).schema ?? 'public';
}

export async function getExistingFrameworkTables(db: PostgresJsDatabase): Promise<string[]> {
  const schemas = collectSchemas([]);
  const liveBySchema = new Map<string, Set<string>>();
  const found: string[] = [];
  for (const name of FRAMEWORK_TABLE_NAMES) {
    const drizzleTable = schemas[`__${name}`];
    if (!drizzleTable) continue;
    const schema = drizzleTableSchema(drizzleTable);
    let live = liveBySchema.get(schema);
    if (!live) {
      live = await getLiveTables(db, schema);
      liveBySchema.set(schema, live);
    }
    if (live.has(name)) found.push(name);
  }
  return found;
}

/**
 * Inspect all framework-managed tables for drift between the live DB
 * and the expected Drizzle schema definitions.
 */
export async function inspectFrameworkDrift(
  db: PostgresJsDatabase,
  entities: EntityDefinition[],
): Promise<DriftReport> {
  const schemas = collectSchemas(entities);
  const liveBySchema = new Map<string, Set<string>>();

  const existingFrameworkTables: string[] = [];
  const missingFrameworkTables: string[] = [];
  const tables: TableDrift[] = [];

  for (const name of FRAMEWORK_TABLE_NAMES) {
    const schemaKey = `__${name}`;
    const drizzleTable = schemas[schemaKey];
    if (!drizzleTable) continue;

    const schema = drizzleTableSchema(drizzleTable);
    let liveTables = liveBySchema.get(schema);
    if (!liveTables) {
      liveTables = await getLiveTables(db, schema);
      liveBySchema.set(schema, liveTables);
    }

    if (liveTables.has(name)) {
      existingFrameworkTables.push(name);
      const expected = getExpectedColumns(drizzleTable);
      const live = await getLiveColumns(db, name, schema);
      tables.push(compareTable(name, expected, live));
    } else {
      missingFrameworkTables.push(name);
      tables.push({ tableName: name, exists: false, columnDrifts: [] });
    }
  }

  const hasDrift = tables.some((t) => t.exists && t.columnDrifts.length > 0);

  return {
    hasDrift,
    existingFrameworkTables,
    missingFrameworkTables,
    tables,
  };
}

/**
 * Extract table names from CREATE TABLE statements in migration SQL.
 * Handles `CREATE TABLE "name"` and `CREATE TABLE name` syntax.
 */
export function extractCreateTableNames(migrationSql: string): string[] {
  const regex =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|[a-zA-Z_]\w*)\.)?(?:"([^"]+)"|([a-zA-Z_]\w*))/gi;
  const names: string[] = [];
  for (const match of migrationSql.matchAll(regex)) {
    const name = match[1] ?? match[2];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Format a drift report as human-readable text lines for CLI output.
 */
export function formatDriftReport(report: DriftReport): string[] {
  const lines: string[] = [];

  if (report.existingFrameworkTables.length > 0) {
    lines.push(`Pre-existing framework tables: ${report.existingFrameworkTables.join(', ')}`);
  }

  for (const table of report.tables) {
    if (!table.exists || table.columnDrifts.length === 0) continue;
    lines.push(`  Table "${table.tableName}" has drift:`);
    for (const d of table.columnDrifts) {
      switch (d.kind) {
        case 'missing_in_db':
          lines.push(`    - Column "${d.column}" is missing (expected: ${d.expected})`);
          break;
        case 'extra_in_db':
          lines.push(
            `    - Column "${d.column}" exists in DB but not in schema (type: ${d.actual})`,
          );
          break;
        case 'type_mismatch':
          lines.push(
            `    - Column "${d.column}" type mismatch: expected ${d.expected}, got ${d.actual}`,
          );
          break;
        case 'nullability_mismatch':
          lines.push(
            `    - Column "${d.column}" nullability: expected ${d.expected}, got ${d.actual}`,
          );
          break;
      }
    }
  }

  lines.push('');
  lines.push('Recovery: If the live schema already matches the current Plumbus schema,');
  lines.push('run `plumbus migrate reconcile` to adopt the existing migration history.');
  lines.push('Otherwise, fix or drop the conflicting framework tables before proceeding.');

  return lines;
}
