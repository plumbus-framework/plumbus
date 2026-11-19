import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { getTableName, is } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { PgDialect, PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { documentChunksTable, documentsTable } from '../ai/rag/schema.js';
import { auditRecords } from '../audit/schema.js';
import { createTenantApprovalTables } from '../approvals/schema.js';
import { createTenantDurableTables } from '../durable/schema.js';
import { deadLetterTable, idempotencyTable, outboxTable } from '../events/outbox.js';
import {
  flowDeadLetterTable,
  flowExecutionsTable,
  flowSchedulesTable,
  flowScheduleTicksTable,
  flowStartIntentsTable,
} from '../flows/schema.js';
import { PlumbusError } from '../errors/plumbus-error.js';
import { jobExecutionsTable } from '../jobs/schema.js';
import type { EntityDefinition } from '../types/entity.js';
import { ErrorCode } from '../types/enums.js';
import { FRAMEWORK_SCHEMA, generateDrizzleSchema } from './schema-generator.js';

export interface MigrationConfig {
  db: PostgresJsDatabase;
  migrationsFolder: string;
  /**
   * Called once when another migration run on the same database holds the migration lock and
   * this run starts waiting for it (CLI: prints a waiting line).
   */
  onLockWait?: () => void;
  /**
   * PostgreSQL `lock_timeout` for every migration statement, in milliseconds. A DDL statement
   * that waits longer than this for a table lock fails instead of queueing every later query
   * on that table behind it; the runner then retries (`lockRetries`). `0` turns the timeout
   * off (wait forever, the behaviour before core 0.9.0-beta.13). Default:
   * {@link DEFAULT_MIGRATION_LOCK_TIMEOUT_MS}. The timeout is scoped to the migration's own
   * transaction (or, for a `-- plumbus:no-transaction` migration, reset after it), so it never
   * reaches the connection pool.
   */
  lockTimeoutMs?: number;
  /**
   * How many more times a migration (a transactional one from its first statement, a
   * non-transactional one from the statement that timed out) is attempted after a lock
   * timeout. Default: {@link DEFAULT_MIGRATION_LOCK_RETRIES}. Exhausted, the run fails with
   * `MigrationLockTimeoutError` and the migration stays pending.
   */
  lockRetries?: number;
  /**
   * Wait before the first retry, in milliseconds; doubled for each later one and capped at
   * 30 s. Default: {@link DEFAULT_MIGRATION_LOCK_RETRY_DELAY_MS}.
   */
  lockRetryDelayMs?: number;
  /** Called before each retry after a lock timeout (CLI: prints a line to stderr). */
  onLockRetry?: (info: MigrationLockRetryInfo) => void;
}

/** What `onLockRetry` is told before the runner tries a timed-out migration again. */
export interface MigrationLockRetryInfo {
  tag: string;
  /** 1-based statement that timed out. */
  statement: number;
  /** 1-based retry about to run. */
  retry: number;
  retries: number;
  delayMs: number;
}

/** Default `lock_timeout` for migration statements: five seconds. */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000;
/** Default number of retries after a migration statement hits its lock timeout. */
export const DEFAULT_MIGRATION_LOCK_RETRIES = 3;
/** Default wait before the first lock-timeout retry (doubled for each later one). */
export const DEFAULT_MIGRATION_LOCK_RETRY_DELAY_MS = 1_000;
const MAX_MIGRATION_LOCK_RETRY_DELAY_MS = 30_000;
/** How often a run waiting for the migration lock asks for it again. */
const MIGRATION_LOCK_POLL_MS = 250;

/**
 * A line of its own in a migration file's leading comment block that makes the runner apply
 * that file outside a transaction, one statement at a time (needed for
 * `CREATE INDEX CONCURRENTLY`). See `applyMigrations`.
 */
export const MIGRATION_NO_TRANSACTION_DIRECTIVE = '-- plumbus:no-transaction';

/** SQLSTATE `lock_not_available`: the statement waited longer than `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';

/** A migration statement failed. The message names the migration, the statement and the SQL. */
export class MigrationStatementError extends PlumbusError {
  constructor(
    message: string,
    metadata: {
      tag: string;
      statement: number;
      statements: number;
      transactional: boolean;
      invalidIndexesDropped?: string[];
      invalidIndexesLeft?: string[];
    },
    readonly cause?: unknown,
  ) {
    super(ErrorCode.Internal, message, metadata);
    this.name = 'MigrationStatementError';
  }
}

/**
 * A migration statement kept failing on its lock timeout after every retry. Nothing of a
 * transactional migration was applied; a non-transactional one applied the statements before
 * the one named here. Either way the migration is still pending and the next run starts it
 * again.
 */
export class MigrationLockTimeoutError extends PlumbusError {
  constructor(
    message: string,
    metadata: {
      tag: string;
      statement: number;
      statements: number;
      transactional: boolean;
      attempts: number;
      lockTimeoutMs: number;
      invalidIndexesDropped?: string[];
      invalidIndexesLeft?: string[];
    },
    readonly cause?: unknown,
  ) {
    super(ErrorCode.Conflict, message, metadata);
    this.name = 'MigrationLockTimeoutError';
  }
}

/**
 * A non-transactional migration finished its statements, but the database holds indexes that
 * PostgreSQL marks invalid (a `CREATE INDEX CONCURRENTLY` that failed earlier and left its
 * index behind; `IF NOT EXISTS` then skips the broken one). The migration is not recorded as
 * applied. Drop the named indexes (`DROP INDEX CONCURRENTLY`) and run the migration again.
 */
export class MigrationInvalidIndexError extends PlumbusError {
  constructor(
    tag: string,
    readonly invalidIndexes: InvalidIndex[],
  ) {
    super(
      ErrorCode.Conflict,
      `Migration "${tag}" ran, but the database has invalid indexes: ` +
        `${invalidIndexes.map(qualifiedIndexName).join(', ')}. The migration was not recorded ` +
        'as applied. Drop them with DROP INDEX CONCURRENTLY and apply again (an index still ' +
        'being built by another session also shows as invalid until it finishes).',
      { tag, invalidIndexes: invalidIndexes.map(qualifiedIndexName) },
    );
    this.name = 'MigrationInvalidIndexError';
  }
}

/** An index PostgreSQL has marked invalid (`pg_index.indisvalid = false`). */
export interface InvalidIndex {
  oid: string;
  schema: string;
  name: string;
  table: string;
}

function qualifiedIndexName(index: InvalidIndex): string {
  return `${index.schema}.${index.name}`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Every invalid index outside the system schemas. */
async function invalidIndexesWith(db: MigrationExecutor): Promise<InvalidIndex[]> {
  const rows = (await db.execute(sql`
    SELECT i.indexrelid::text AS oid, n.nspname AS schema, c.relname AS name, t.relname AS "table"
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE NOT i.indisvalid
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY n.nspname, c.relname
  `)) as unknown as InvalidIndex[];
  return [...rows];
}

/**
 * Indexes PostgreSQL marks invalid in this database: what a failed `CREATE INDEX CONCURRENTLY`
 * leaves behind. A deployment check can call it after `migrate apply`; the runner itself
 * refuses to record a non-transactional migration while any exist.
 */
export async function listInvalidIndexes(db: PostgresJsDatabase): Promise<InvalidIndex[]> {
  return invalidIndexesWith({ execute: (query) => db.execute(query) });
}

function sqlStateOf(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isLockTimeout(error: unknown): boolean {
  return sqlStateOf(error) === LOCK_NOT_AVAILABLE;
}

function wholeMilliseconds(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `${name} must be a whole number of milliseconds, 0 or more (received ${String(value)})`,
    );
  }
  return value;
}

interface LockPolicy {
  timeoutMs: number;
  retries: number;
  delayMs: number;
  onRetry?: (info: MigrationLockRetryInfo) => void;
}

function lockPolicyOf(config: MigrationConfig): LockPolicy {
  const retries = config.lockRetries ?? DEFAULT_MIGRATION_LOCK_RETRIES;
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `lockRetries must be a whole number, 0 or more (received ${String(retries)})`,
    );
  }
  return {
    timeoutMs: wholeMilliseconds(
      config.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
      'lockTimeoutMs',
    ),
    retries,
    delayMs: wholeMilliseconds(
      config.lockRetryDelayMs ?? DEFAULT_MIGRATION_LOCK_RETRY_DELAY_MS,
      'lockRetryDelayMs',
    ),
    onRetry: config.onLockRetry,
  };
}

function retryDelay(policy: LockPolicy, retry: number): number {
  return Math.min(policy.delayMs * 2 ** (retry - 1), MAX_MIGRATION_LOCK_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Session advisory lock key every migration run takes on the database it migrates ("PLUMBUS"
 * plus a version byte). Advisory locks are per database, so separate tenant databases never
 * wait on each other.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = '5786093411577975553';

/** Executes one statement; `PostgresJsDatabase` and a transaction both satisfy it. */
interface MigrationExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

/** Where one migration run sends its SQL: a locked connection, or the plain handle. */
interface MigrationSession extends MigrationExecutor {
  transaction<T>(work: (tx: MigrationExecutor) => Promise<T>): Promise<T>;
}

interface ReservedPostgresClient {
  unsafe(query: string, params?: unknown[]): PromiseLike<unknown>;
  release(): void;
}

interface ReservablePostgresClient {
  reserve(): Promise<ReservedPostgresClient>;
}

function reservableClientOf(db: PostgresJsDatabase): ReservablePostgresClient | undefined {
  const client = (db as { $client?: unknown }).$client;
  if (
    typeof client === 'function' &&
    typeof (client as Partial<ReservablePostgresClient>).reserve === 'function'
  ) {
    return client as unknown as ReservablePostgresClient;
  }
  return undefined;
}

const migrationDialect = new PgDialect();

function reservedSession(connection: ReservedPostgresClient): MigrationSession {
  const execute = (query: SQL) => {
    const built = migrationDialect.sqlToQuery(query);
    return connection.unsafe(built.sql, built.params);
  };
  return {
    execute,
    async transaction(work) {
      // A reserved postgres.js connection has no `begin`; the transaction is spelled out so
      // it stays on the connection that holds the lock (a pool of one cannot lend another).
      await connection.unsafe('BEGIN');
      try {
        const result = await work({ execute });
        await connection.unsafe('COMMIT');
        return result;
      } catch (error) {
        await Promise.resolve(connection.unsafe('ROLLBACK')).catch(() => undefined);
        throw error;
      }
    },
  };
}

/**
 * Run `work` while holding the database's migration lock, so concurrent `migrate apply` runs
 * (several pods, a Job and a developer) apply each migration once: the second run waits, then
 * reads the history the first one wrote. The lock is a session advisory lock on one reserved
 * connection and all of the run's SQL goes over that connection, so a pool of one works and a
 * crashed run releases the lock with its connection.
 *
 * A waiting run asks again every {@link MIGRATION_LOCK_POLL_MS} with `pg_try_advisory_lock`
 * rather than blocking in `pg_advisory_lock`: a blocked call is an open transaction, and
 * `CREATE INDEX CONCURRENTLY` in the holder's run waits for every open transaction — the two
 * runs would deadlock and PostgreSQL would abort the index build.
 *
 * A handle without a reservable postgres.js client (test doubles) runs unlocked; the unique
 * history hash still refuses a second record of the same migration.
 */
async function withMigrationLock<T>(
  db: PostgresJsDatabase,
  work: (session: MigrationSession) => Promise<T>,
  onLockWait?: () => void,
): Promise<T> {
  const client = reservableClientOf(db);
  if (!client) {
    return work({
      execute: (query) => db.execute(query),
      transaction: (fn) => db.transaction((tx) => fn(tx)),
    });
  }

  const connection = await client.reserve();
  try {
    const tryLock = async () =>
      (
        (await connection.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
          MIGRATION_ADVISORY_LOCK_KEY,
        ])) as Array<{ acquired: boolean }>
      )[0]?.acquired === true;
    if (!(await tryLock())) {
      onLockWait?.();
      while (!(await tryLock())) await sleep(MIGRATION_LOCK_POLL_MS);
    }
    try {
      return await work(reservedSession(connection));
    } finally {
      await Promise.resolve(
        connection.unsafe('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]),
      ).catch(() => undefined);
    }
  } finally {
    connection.release();
  }
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
  /**
   * `false` when the file's leading comment block carries
   * {@link MIGRATION_NO_TRANSACTION_DIRECTIVE}: its statements run one at a time outside a
   * transaction.
   */
  transactional: boolean;
}

/**
 * Whether the leading comment block of a migration (the `--` lines before its first
 * statement) holds the no-transaction directive on a line of its own.
 */
function declaresNoTransaction(rawSql: string): boolean {
  for (const line of rawSql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('--')) return false;
    if (trimmed === MIGRATION_NO_TRANSACTION_DIRECTIVE) return true;
  }
  return false;
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
      transactional: !declaresNoTransaction(rawSql),
    };
  });
}

async function ensureMigrationsTable(db: MigrationExecutor): Promise<void> {
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
  await ensureUniqueMigrationHash(db);
  await adoptLegacyPublicMigrationHistory(db);
}

/**
 * One history row per migration hash. Tables created before core 0.9.0-beta.1 had no unique
 * key, so an unlocked concurrent apply could record a migration twice: keep the oldest row of
 * each hash (the set of applied hashes does not change), then add the unique index. Both
 * statements are no-ops once the index exists.
 */
async function ensureUniqueMigrationHash(db: MigrationExecutor): Promise<void> {
  await db.execute(sql`
    DELETE FROM "drizzle"."__drizzle_migrations" AS duplicate
    USING "drizzle"."__drizzle_migrations" AS kept
    WHERE duplicate.hash = kept.hash
      AND duplicate.id > kept.id
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "__drizzle_migrations_hash_key"
    ON "drizzle"."__drizzle_migrations" (hash)
  `);
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
async function legacyPublicMigrationsTableExists(db: MigrationExecutor): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '__drizzle_migrations'
    LIMIT 1
  `)) as unknown as unknown[];

  return rows.length > 0;
}

async function adoptLegacyPublicMigrationHistory(db: MigrationExecutor): Promise<void> {
  if (!(await legacyPublicMigrationsTableExists(db))) {
    return;
  }

  await db.execute(sql`
    INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
    SELECT DISTINCT ON (legacy.hash) legacy.hash, legacy.created_at
    FROM "public"."__drizzle_migrations" AS legacy
    ORDER BY legacy.hash, legacy.id
    ON CONFLICT (hash) DO NOTHING
  `);
}

async function getAppliedMigrationHashes(db: MigrationExecutor): Promise<Set<string>> {
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
  return withMigrationLock(
    config.db,
    (session) => readPendingWith(session, config.migrationsFolder),
    config.onLockWait,
  );
}

/**
 * Pending journal migrations, one per hash: the history is keyed by hash, so a second journal
 * entry with byte-identical SQL counts as the same migration (as it already did on any
 * database that had applied the first one).
 */
async function readPendingWith(
  db: MigrationExecutor,
  migrationsFolder: string,
): Promise<PendingMigration[]> {
  await ensureMigrationsTable(db);

  const appliedHashes = await getAppliedMigrationHashes(db);
  const journalMigrations = readJournalMigrations(migrationsFolder);

  const seen = new Set(appliedHashes);
  return journalMigrations.filter((migration) => {
    if (seen.has(migration.hash)) return false;
    seen.add(migration.hash);
    return true;
  });
}

/**
 * Apply pending migrations from the migrations folder.
 *
 * Each migration runs inside a transaction whose statements carry a `lock_timeout`
 * (`lockTimeoutMs`, default five seconds): a DDL statement that cannot get its table lock in
 * time is rolled back with the rest of the migration and the migration is retried
 * (`lockRetries`, with a doubling delay) instead of queueing every query on that table behind
 * it. On failure, the error includes the migration tag, statement index, and a SQL preview.
 *
 * A migration whose leading comment block has the line `-- plumbus:no-transaction`
 * ({@link MIGRATION_NO_TRANSACTION_DIRECTIVE}) runs outside a transaction, one statement per
 * `--> statement-breakpoint` and each committed on its own — the only way to run
 * `CREATE INDEX CONCURRENTLY`. Its history row is written only after its last statement, so a
 * failure leaves it pending and the next run starts it again from its first statement: write
 * every statement so a second run is harmless (`IF NOT EXISTS` / `IF EXISTS`). When one of its
 * statements fails, the runner drops (`DROP INDEX CONCURRENTLY`) any index that became invalid
 * during that attempt, and it records the migration only when the database holds no invalid
 * index afterwards ({@link MigrationInvalidIndexError}).
 *
 * The whole run holds the database's migration lock (see `MIGRATION_ADVISORY_LOCK_KEY`):
 * a concurrent run waits, then finds the migrations this one applied already recorded.
 */
export async function applyMigrations(config: MigrationConfig): Promise<MigrationApplyResult> {
  const policy = lockPolicyOf(config);
  return withMigrationLock(
    config.db,
    (session) => applyPendingWith(session, config.migrationsFolder, policy),
    config.onLockWait,
  );
}

async function applyPendingWith(
  session: MigrationSession,
  migrationsFolder: string,
  policy: LockPolicy,
): Promise<MigrationApplyResult> {
  const pending = await readPendingWith(session, migrationsFolder);

  if (pending.length === 0) {
    return { applied: 0, tags: [] };
  }

  const appliedTags: string[] = [];
  for (const migration of pending) {
    if (migration.transactional) {
      await applyInTransaction(session, migration, policy);
    } else {
      await applyWithoutTransaction(session, migration, policy);
    }
    appliedTags.push(migration.tag);
  }

  return { applied: appliedTags.length, tags: appliedTags };
}

function recordApplied(db: MigrationExecutor, migration: PendingMigration): PromiseLike<unknown> {
  return db.execute(
    sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`,
  );
}

function statementFailureMessage(
  migration: PendingMigration,
  index: number,
  error: unknown,
): string {
  const stmt = migration.statements[index] ?? '';
  const preview = stmt.length > 200 ? `${stmt.slice(0, 200)}...` : stmt;
  return (
    `Migration "${migration.tag}" failed at statement ${index + 1}/${migration.statements.length}:\n` +
    `  SQL: ${preview}\n` +
    `  Error: ${error instanceof Error ? error.message : String(error)}`
  );
}

/** Thrown inside the transaction so the retry loop can see which statement failed. */
class StatementFailure {
  constructor(
    readonly index: number,
    readonly error: unknown,
  ) {}
}

async function applyInTransaction(
  session: MigrationSession,
  migration: PendingMigration,
  policy: LockPolicy,
): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    try {
      await session.transaction(async (tx) => {
        // SET LOCAL ends with the transaction, so the setting never outlives this migration.
        if (policy.timeoutMs > 0) {
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${policy.timeoutMs}`));
        }
        for (let i = 0; i < migration.statements.length; i++) {
          try {
            await tx.execute(sql.raw(migration.statements[i] ?? ''));
          } catch (error) {
            throw new StatementFailure(i, error);
          }
        }
        await recordApplied(tx, migration);
      });
      return;
    } catch (thrown) {
      if (!(thrown instanceof StatementFailure)) throw thrown;
      const metadata = {
        tag: migration.tag,
        statement: thrown.index + 1,
        statements: migration.statements.length,
        transactional: true,
      };
      const message = statementFailureMessage(migration, thrown.index, thrown.error);
      if (!isLockTimeout(thrown.error)) {
        throw new MigrationStatementError(message, metadata, thrown.error);
      }
      if (retry >= policy.retries) {
        throw new MigrationLockTimeoutError(
          `${message}\n  The statement waited longer than lock_timeout (${policy.timeoutMs} ms) ` +
            `on every one of ${retry + 1} attempts; nothing of this migration was applied and it ` +
            'is still pending. Find the session holding the lock (pg_stat_activity, pg_locks) ' +
            'or raise lockTimeoutMs / --lock-timeout.',
          { ...metadata, attempts: retry + 1, lockTimeoutMs: policy.timeoutMs },
          thrown.error,
        );
      }
      const delayMs = retryDelay(policy, retry + 1);
      policy.onRetry?.({
        tag: migration.tag,
        statement: thrown.index + 1,
        retry: retry + 1,
        retries: policy.retries,
        delayMs,
      });
      await sleep(delayMs);
    }
  }
}

/**
 * Drop every invalid index whose oid is not in `before`: what this attempt's failed
 * `CREATE INDEX CONCURRENTLY` left behind. Returns what was dropped and what could not be.
 */
async function dropNewInvalidIndexes(
  session: MigrationSession,
  before: ReadonlySet<string>,
): Promise<{ dropped: string[]; left: string[] }> {
  const dropped: string[] = [];
  const left: string[] = [];
  let current: InvalidIndex[];
  try {
    current = await invalidIndexesWith(session);
  } catch {
    return { dropped, left };
  }
  for (const index of current) {
    if (before.has(index.oid)) continue;
    try {
      await session.execute(
        sql.raw(
          `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(index.schema)}.${quoteIdent(index.name)}`,
        ),
      );
      dropped.push(qualifiedIndexName(index));
    } catch {
      left.push(qualifiedIndexName(index));
    }
  }
  return { dropped, left };
}

async function applyWithoutTransaction(
  session: MigrationSession,
  migration: PendingMigration,
  policy: LockPolicy,
): Promise<void> {
  // A session setting on the reserved connection; reset below before the connection goes
  // back to the pool.
  if (policy.timeoutMs > 0) {
    await session.execute(sql.raw(`SET lock_timeout = ${policy.timeoutMs}`));
  }
  try {
    for (let i = 0; i < migration.statements.length; i++) {
      for (let retry = 0; ; retry += 1) {
        const before = new Set((await invalidIndexesWith(session)).map((index) => index.oid));
        try {
          await session.execute(sql.raw(migration.statements[i] ?? ''));
          break;
        } catch (error) {
          const cleanup = await dropNewInvalidIndexes(session, before);
          const metadata = {
            tag: migration.tag,
            statement: i + 1,
            statements: migration.statements.length,
            transactional: false,
            ...(cleanup.dropped.length > 0 ? { invalidIndexesDropped: cleanup.dropped } : {}),
            ...(cleanup.left.length > 0 ? { invalidIndexesLeft: cleanup.left } : {}),
          };
          const committed =
            i === 0 ? 'No earlier statement of it had run.' : `Statements 1-${i} were committed.`;
          const message =
            `${statementFailureMessage(migration, i, error)}\n` +
            `  This migration runs without a transaction. ${committed} It is still pending and ` +
            'the next run starts it again from its first statement.' +
            (cleanup.left.length > 0
              ? ` Invalid indexes left behind (drop them before the next run): ${cleanup.left.join(', ')}.`
              : '');
          if (!isLockTimeout(error)) throw new MigrationStatementError(message, metadata, error);
          if (retry >= policy.retries) {
            throw new MigrationLockTimeoutError(
              `${message}\n  The statement waited longer than lock_timeout ` +
                `(${policy.timeoutMs} ms) on every one of ${retry + 1} attempts.`,
              { ...metadata, attempts: retry + 1, lockTimeoutMs: policy.timeoutMs },
              error,
            );
          }
          const delayMs = retryDelay(policy, retry + 1);
          policy.onRetry?.({
            tag: migration.tag,
            statement: i + 1,
            retry: retry + 1,
            retries: policy.retries,
            delayMs,
          });
          await sleep(delayMs);
        }
      }
    }
    // `CREATE INDEX CONCURRENTLY IF NOT EXISTS` skips an index of the same name that an earlier
    // failed run left invalid; recording the migration then would hide the broken index.
    const invalid = await invalidIndexesWith(session);
    if (invalid.length > 0) throw new MigrationInvalidIndexError(migration.tag, invalid);
    await recordApplied(session, migration);
  } finally {
    if (policy.timeoutMs > 0) {
      await Promise.resolve(session.execute(sql.raw('RESET lock_timeout'))).catch(() => undefined);
    }
  }
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
  return withMigrationLock(
    config.db,
    (session) => reconcileWith(session, journalMigrations),
    config.onLockWait,
  );
}

async function reconcileWith(
  session: MigrationSession,
  journalMigrations: PendingMigration[],
): Promise<MigrationReconcileResult> {
  await ensureMigrationsTable(session);
  const appliedHashes = await getAppliedMigrationHashes(session);
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

  await session.transaction(async (tx) => {
    for (const migration of missingMigrations) {
      await tx.execute(
        sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
            VALUES (${migration.hash}, ${migration.folderMillis})
            ON CONFLICT (hash) DO NOTHING`,
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
  schemas.__flow_schedule_ticks = flowScheduleTicksTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(flowScheduleTicksTable));
  schemas.__flow_schedules = flowSchedulesTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(flowSchedulesTable));
  schemas.__flow_start_intents = flowStartIntentsTable as unknown as PgTableWithColumns<any>;
  tableNames.add(getTableName(flowStartIntentsTable));
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
  return withMigrationLock(
    config.db,
    (session) => rollbackWith(session, config.migrationsFolder),
    config.onLockWait,
  );
}

async function rollbackWith(
  db: MigrationExecutor,
  migrationsFolder: string,
): Promise<MigrationRollbackResult> {
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

  // Delete by id: history written before the unique hash key may repeat a hash.
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
