// ── Framework Migration Rewriter ──
// Transforms drizzle-kit's raw migration SQL so that it can be safely applied
// against a database whose framework-managed tables (flow_executions, etc.)
// already exist but are missing newly-added framework columns.
//
// Why this exists:
//   When a project upgrades `@plumbus/core`, the framework's own table schemas
//   may have grown new columns (e.g. flow leasing added `lease_owner` and
//   `lease_expires_at` to `flow_executions`). Drizzle-kit, which generates
//   migrations purely from snapshot diffs, has no awareness of which tables
//   are framework-managed and emits `CREATE TABLE` for the entire framework
//   table — even when the table already exists in the live DB. That migration
//   is then rejected by the `migrate apply` preflight ("framework table
//   already exists"), leaving users with no clean upgrade path.
//
// What this does:
//   Given the raw SQL drizzle-kit produced and a `DriftReport` from
//   `inspectFrameworkDrift`, we rewrite the SQL so that:
//     • CREATE TABLE statements for framework tables that already exist are
//       replaced with one ALTER TABLE … ADD COLUMN per `missing_in_db`
//       column reported by the drift inspector. Column type/null/default
//       text is parsed verbatim out of the original CREATE TABLE body so we
//       inherit drizzle-kit's exact serialization.
//     • CREATE TABLE statements for framework tables whose columns already
//       fully match the schema are dropped entirely.
//     • CREATE INDEX / CREATE UNIQUE INDEX statements are wrapped with
//       IF NOT EXISTS so re-running on a partially migrated DB doesn't trip
//       on indexes that already exist (Postgres ≥ 9.5).
//     • Everything else (entity tables, ALTERs to entity tables, constraints,
//       etc.) passes through unchanged.
//
// Limitations (future work):
//   • IF NOT EXISTS only suppresses the duplicate-name error on relations
//     and indexes; it does NOT verify that the existing definition actually
//     matches what the migration intends. Safe full reconciliation requires
//     comparing columns, defaults, constraints, and indexes — see
//     `inspectFrameworkDrift` for a starting point. We currently only act
//     on `missing_in_db` columns; `type_mismatch`, `nullability_mismatch`,
//     and `extra_in_db` are surfaced in the summary but not auto-rewritten,
//     because resolving them safely usually needs human judgment.
//   • CONSTRAINT clauses inside a rewrite-target CREATE TABLE (e.g. table-
//     level UNIQUE / CHECK) are dropped with a warning — Postgres has no
//     ADD CONSTRAINT IF NOT EXISTS, so we can't safely re-add idempotently.

import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import {
  type DriftReport,
  FRAMEWORK_TABLE_NAMES,
  type FrameworkTableName,
} from './drift-inspector.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const FRAMEWORK_TABLE_SET = new Set<string>(FRAMEWORK_TABLE_NAMES as readonly string[]);

export interface RewriteSummary {
  /** Framework tables for which we emitted ALTER TABLE ADD COLUMN. */
  alteredTables: Array<{ table: FrameworkTableName; addedColumns: string[] }>;
  /** Framework tables whose CREATE TABLE we dropped because they were already in sync. */
  droppedCreateTables: FrameworkTableName[];
  /** CREATE INDEX statements we wrapped with IF NOT EXISTS. */
  wrappedIndexes: string[];
  /**
   * `ALTER TABLE … ADD COLUMN` statements we rewrote to `ADD COLUMN IF NOT
   * EXISTS` so the migration is idempotent against partial-state databases
   * (e.g. ones that received hand-applied DDL before the framework owned
   * snapshot bookkeeping). Each entry is a `"<table>"."<column>"` label.
   */
  idempotentAddColumns: string[];
  /** Non-fatal warnings (e.g. dropped CONSTRAINT clauses, type mismatches we can't auto-fix). */
  warnings: string[];
}

export interface RewriteResult {
  /** The rewritten statements (one SQL statement per element). */
  statements: string[];
  summary: RewriteSummary;
}

/**
 * Rewrite drizzle-kit migration statements to be safe against framework-table
 * drift.
 *
 * Operates on the raw `string[]` that `drizzle-kit/api.generateMigration`
 * returns — one element per SQL statement. Returns a new array of statements
 * (some may be removed, some may expand into multiple ALTER TABLE …
 * statements) along with a structured summary for logging.
 *
 * Pure function — no IO, no DB access.
 *
 * If the report contains no `existingFrameworkTables`, the input is returned
 * unchanged apart from index IF NOT EXISTS wrapping, which is always safe.
 */
export function rewriteFrameworkDriftMigration(
  inputStatements: string[],
  driftReport: DriftReport,
  _schemas?: Record<string, PgTableWithColumns<any>>,
): RewriteResult {
  const summary: RewriteSummary = {
    alteredTables: [],
    droppedCreateTables: [],
    wrappedIndexes: [],
    idempotentAddColumns: [],
    warnings: [],
  };

  const driftByTable = new Map<string, (typeof driftReport.tables)[number]>();
  for (const table of driftReport.tables) {
    driftByTable.set(table.tableName, table);
  }
  const existingFrameworkSet = new Set(driftReport.existingFrameworkTables);

  const out: string[] = [];

  for (const stmt of inputStatements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;

    const createTableName = matchCreateTableName(trimmed);
    if (createTableName && existingFrameworkSet.has(createTableName)) {
      const tableDrift = driftByTable.get(createTableName);
      const missing = tableDrift?.columnDrifts.filter((d) => d.kind === 'missing_in_db') ?? [];

      if (missing.length === 0) {
        // Table already fully matches — drop the CREATE TABLE.
        summary.droppedCreateTables.push(createTableName as FrameworkTableName);
        continue;
      }

      const parsed = parseCreateTableBody(trimmed);
      if (!parsed) {
        // Couldn't parse safely — leave as-is and warn. Apply preflight will
        // still catch the conflict; better to fail loudly than to lose data.
        summary.warnings.push(
          `Could not parse CREATE TABLE for "${createTableName}"; passing through unchanged.`,
        );
        out.push(stmt);
        continue;
      }

      const columnLineByName = new Map(parsed.columnLines.map((c) => [c.name, c.line]));
      const altered: string[] = [];
      const alterStatements: string[] = [];

      for (const col of missing) {
        const line = columnLineByName.get(col.column);
        if (!line) {
          // Drift inspector reported a missing column but drizzle-kit didn't
          // include a definition for it — schema desync. Warn and skip.
          summary.warnings.push(
            `Drift reported missing column "${createTableName}.${col.column}" but the generated CREATE TABLE has no matching definition.`,
          );
          continue;
        }
        alterStatements.push(`ALTER TABLE "${createTableName}" ADD COLUMN ${line};`);
        altered.push(col.column);
      }

      if (parsed.constraintLines.length > 0) {
        summary.warnings.push(
          `Dropped ${parsed.constraintLines.length} table-level constraint clause(s) from CREATE TABLE for "${createTableName}" because Postgres does not support ADD CONSTRAINT IF NOT EXISTS. If a new framework constraint is required, add it manually.`,
        );
      }

      if (alterStatements.length === 0) {
        summary.droppedCreateTables.push(createTableName as FrameworkTableName);
        continue;
      }

      summary.alteredTables.push({
        table: createTableName as FrameworkTableName,
        addedColumns: altered,
      });
      // Push each ALTER as its own array element so the caller can join with
      // any separator (including a literal newline, which is what drizzle-kit
      // already does for migration files).
      for (const a of alterStatements) out.push(a);
      continue;
    }

    const indexWrapped = wrapCreateIndexIfNotExists(trimmed);
    if (indexWrapped !== trimmed) {
      summary.wrappedIndexes.push(extractIndexName(trimmed) ?? '<anonymous>');
      out.push(indexWrapped);
      continue;
    }

    const addColWrapped = wrapAlterAddColumnIfNotExists(trimmed);
    if (addColWrapped !== trimmed) {
      summary.idempotentAddColumns.push(extractAddColumnTarget(trimmed) ?? '<unknown>');
      out.push(addColWrapped);
      continue;
    }

    out.push(stmt);
  }

  return {
    statements: out,
    summary,
  };
}

// ── Internals ──

/**
 * Re-exported for callers that want to render rewritten statements with the
 * same separator drizzle-kit uses internally for breakpoint-aware tooling.
 */
export const STATEMENT_BREAKPOINT_MARKER = STATEMENT_BREAKPOINT;

const CREATE_TABLE_HEAD_RE =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|[a-zA-Z_]\w*)\.)?(?:"([^"]+)"|([a-zA-Z_]\w*))/i;

function matchCreateTableName(stmt: string): string | null {
  const m = stmt.match(CREATE_TABLE_HEAD_RE);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

interface ParsedCreateTable {
  columnLines: Array<{ name: string; line: string }>;
  /**
   * Lines inside the CREATE TABLE body that look like table-level constraints
   * rather than column definitions (CONSTRAINT, PRIMARY KEY, UNIQUE, CHECK,
   * FOREIGN KEY at the start of the line). We collect them so the rewriter
   * can warn if it had to drop any while emitting only ALTER TABLE ADD COLUMN.
   */
  constraintLines: string[];
}

const TABLE_LEVEL_CONSTRAINT_KEYWORDS = [
  'CONSTRAINT',
  'PRIMARY KEY',
  'UNIQUE',
  'CHECK',
  'FOREIGN KEY',
  'EXCLUDE',
];

/**
 * Parse the parenthesized body of a CREATE TABLE statement into individual
 * column definition lines. Drizzle-kit emits one column per line, separated
 * by commas, with the column name as a quoted identifier at the start.
 *
 * Returns null if the body cannot be located (e.g. no opening paren).
 */
function parseCreateTableBody(stmt: string): ParsedCreateTable | null {
  const openIdx = stmt.indexOf('(');
  if (openIdx < 0) return null;

  // Find the matching closing paren. Drizzle-kit-generated bodies don't
  // contain nested parens for our purposes (no inline CHECK constraints etc.
  // — those would surface as constraintLines). We still scan with depth so we
  // don't get fooled by anything embedded.
  let depth = 0;
  let closeIdx = -1;
  let inSingleQuote = false;
  for (let i = openIdx; i < stmt.length; i++) {
    const ch = stmt[i];
    if (ch === "'" && stmt[i - 1] !== '\\') inSingleQuote = !inSingleQuote;
    if (inSingleQuote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return null;

  const body = stmt.slice(openIdx + 1, closeIdx);

  // Split by top-level commas (no nesting expected in column defs, but be
  // defensive about quoted strings and parens just in case).
  const segments = splitTopLevelCommas(body);

  const columnLines: Array<{ name: string; line: string }> = [];
  const constraintLines: string[] = [];

  for (const raw of segments) {
    const line = raw.trim();
    if (!line) continue;
    if (isConstraintLine(line)) {
      constraintLines.push(line);
      continue;
    }
    const nameMatch = line.match(/^"([^"]+)"\s+(.+)$/) ?? line.match(/^([a-zA-Z_]\w*)\s+(.+)$/);
    if (!nameMatch) {
      // Unrecognized — treat as constraint to be safe (will trigger warning).
      constraintLines.push(line);
      continue;
    }
    const colName = nameMatch[1] as string;
    columnLines.push({ name: colName, line });
  }

  return { columnLines, constraintLines };
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingleQuote = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" && body[i - 1] !== '\\') inSingleQuote = !inSingleQuote;
    if (inSingleQuote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function isConstraintLine(line: string): boolean {
  const upper = line.toUpperCase();
  return TABLE_LEVEL_CONSTRAINT_KEYWORDS.some((kw) => upper.startsWith(kw));
}

const CREATE_INDEX_RE = /^(\s*)CREATE\s+(UNIQUE\s+)?INDEX(?!\s+IF\s+NOT\s+EXISTS\b)\s+/i;

function wrapCreateIndexIfNotExists(stmt: string): string {
  return stmt.replace(CREATE_INDEX_RE, (_match, leading: string, unique?: string) => {
    const u = unique ? unique : '';
    return `${leading}CREATE ${u}INDEX IF NOT EXISTS `;
  });
}

const INDEX_NAME_RE = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([^"\s]+)"?/i;

function extractIndexName(stmt: string): string | null {
  const m = stmt.match(INDEX_NAME_RE);
  return m?.[1] ?? null;
}

// Match `ALTER TABLE [IF EXISTS] <tbl> ADD COLUMN [IF NOT EXISTS]`. We only
// want to rewrite when IF NOT EXISTS is *not* already present. Multiple
// ADD COLUMN clauses can appear in one ALTER TABLE statement separated by
// commas; we wrap every one of them.
const ALTER_ADD_COLUMN_RE = /\bADD\s+COLUMN(?!\s+IF\s+NOT\s+EXISTS\b)\s+/gi;

function isAlterTableStatement(stmt: string): boolean {
  return /^\s*ALTER\s+TABLE\b/i.test(stmt);
}

/**
 * Rewrite `ALTER TABLE … ADD COLUMN <name> …` to `ADD COLUMN IF NOT EXISTS
 * <name> …`. We do not touch `ADD CONSTRAINT`, `ALTER COLUMN`, etc.
 *
 * Why universal idempotency:
 *   Drizzle-kit's diff-based generation depends on the snapshot in
 *   drizzle/meta accurately reflecting the live schema. Real projects
 *   accumulate snapshot drift (manually edited migrations, partial applies,
 *   prod hotfixes). Making framework-emitted ADD COLUMN idempotent removes a
 *   whole class of "column already exists" apply failures without changing
 *   semantics: a real type/default mismatch will still surface elsewhere
 *   (e.g. queries failing at runtime), and the apply path remains a no-op
 *   when the column is already there.
 *
 * Limitation (future work, mirrors the index case):
 *   Postgres' `IF NOT EXISTS` only suppresses the duplicate-name error; it
 *   does NOT verify that the existing column matches the requested type,
 *   nullability, or default. Comprehensive reconciliation requires
 *   `inspectFrameworkDrift`-style comparison across every column for every
 *   user-managed entity, not just the framework-managed tables.
 */
function wrapAlterAddColumnIfNotExists(stmt: string): string {
  if (!isAlterTableStatement(stmt)) return stmt;
  return stmt.replace(ALTER_ADD_COLUMN_RE, 'ADD COLUMN IF NOT EXISTS ');
}

const ALTER_TABLE_TARGET_RE =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_]\w*))/i;
const ADD_COLUMN_NAME_RE =
  /\bADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([a-zA-Z_]\w*))/gi;

function extractAddColumnTarget(stmt: string): string | null {
  const tableMatch = stmt.match(ALTER_TABLE_TARGET_RE);
  const table = tableMatch?.[1] ?? tableMatch?.[2] ?? null;
  if (!table) return null;
  const columns: string[] = [];
  for (const m of stmt.matchAll(ADD_COLUMN_NAME_RE)) {
    columns.push(m[1] ?? (m[2] as string));
  }
  if (columns.length === 0) return `"${table}"`;
  return `"${table}".${columns.map((c) => `"${c}"`).join(',')}`;
}

/**
 * Convenience: format the rewriter summary for human-readable CLI output.
 * Returns an array of lines (no trailing newlines), or an empty array if no
 * meaningful rewriting happened.
 */
export function formatRewriteSummary(summary: RewriteSummary): string[] {
  const lines: string[] = [];
  if (summary.alteredTables.length > 0) {
    lines.push('Framework drift rewrite: emitted ALTER TABLE ADD COLUMN for:');
    for (const t of summary.alteredTables) {
      lines.push(`  ${t.table}: ${t.addedColumns.join(', ')}`);
    }
  }
  if (summary.droppedCreateTables.length > 0) {
    lines.push(
      `Framework drift rewrite: dropped redundant CREATE TABLE for: ${summary.droppedCreateTables.join(', ')}`,
    );
  }
  if (summary.wrappedIndexes.length > 0) {
    lines.push(
      `Framework drift rewrite: wrapped ${summary.wrappedIndexes.length} CREATE INDEX statement(s) with IF NOT EXISTS.`,
    );
  }
  if (summary.idempotentAddColumns.length > 0) {
    lines.push(
      `Framework drift rewrite: made ${summary.idempotentAddColumns.length} ALTER TABLE ADD COLUMN statement(s) idempotent.`,
    );
  }
  for (const w of summary.warnings) {
    lines.push(`  warning: ${w}`);
  }
  return lines;
}

/**
 * True if the rewriter actually changed anything beyond cosmetic whitespace.
 * Useful for skipping noisy logs when the migration was clean already.
 */
export function rewriteHadEffect(summary: RewriteSummary): boolean {
  return (
    summary.alteredTables.length > 0 ||
    summary.droppedCreateTables.length > 0 ||
    summary.wrappedIndexes.length > 0 ||
    summary.idempotentAddColumns.length > 0 ||
    summary.warnings.length > 0
  );
}

// Re-export so callers can keep a single import surface.
export { FRAMEWORK_TABLE_SET };
