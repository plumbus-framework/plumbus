// DDL safety of the migration runner against a real Postgres: a lock timeout on every
// migration statement (bounded retry, typed refusal), and `-- plumbus:no-transaction`
// migrations that can build an index concurrently, with the history kept correct when one
// fails halfway and leaves an invalid index behind.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createDurableTestDatabase, resolveTestPostgresAdmin } from '../../durable/index.js';
import {
  applyMigrations,
  listInvalidIndexes,
  type MigrationLockRetryInfo,
  MigrationInvalidIndexError,
  MigrationLockTimeoutError,
  MigrationStatementError,
  readPendingMigrations,
} from '../migration.js';

const admin = resolveTestPostgresAdmin();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function writeMigrations(files: Array<{ tag: string; sql: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migration-ddl-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'meta'));
  for (const file of files) fs.writeFileSync(path.join(dir, `${file.tag}.sql`), file.sql);
  fs.writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      entries: files.map((file, idx) => ({
        idx,
        version: '7',
        when: 1000 + idx,
        tag: file.tag,
        breakpoints: true,
      })),
    }),
  );
  return dir;
}

async function testDatabase(): Promise<string> {
  const database = await createDurableTestDatabase({ admin, kind: 'migration_ddl', ddl: '' });
  cleanups.push(() => database.close());
  return database.name;
}

function client(database: string, max = 1) {
  const sql = postgres({
    host: admin.host,
    port: admin.port,
    database,
    username: admin.user,
    password: admin.password,
    max,
    onnotice: () => {},
  });
  cleanups.push(() => sql.end({ timeout: 5 }));
  return { sql, db: drizzle(sql) };
}

async function historyCount(sql: postgres.Sql): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"
  `;
  return rows[0]?.n ?? 0;
}

/**
 * Hold ACCESS SHARE on `table` in an open transaction (any reader does) until `release()`:
 * the lock an ALTER TABLE has to wait for.
 */
async function holdReaderLock(database: string, table: string) {
  const { sql } = client(database);
  const reserved = await sql.reserve();
  await reserved.unsafe('BEGIN');
  await reserved.unsafe(`SELECT count(*) FROM ${table}`);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await reserved.unsafe('COMMIT');
    reserved.release();
  };
  cleanups.push(release);
  return release;
}

const NO_TX = '-- plumbus:no-transaction\n';

describe('migration lock timeout', () => {
  it('fails a DDL statement that cannot get its lock, retries a bounded number of times and records nothing', async () => {
    const database = await testDatabase();
    const { sql, db } = client(database);
    await sql`CREATE TABLE busy (id int)`;
    const release = await holdReaderLock(database, 'busy');
    // Released only after the runner should have given up (2 attempts × 150 ms + 50 ms delay).
    const releaseLater = setTimeout(() => void release(), 4_000);
    cleanups.push(async () => clearTimeout(releaseLater));

    const folder = writeMigrations([
      { tag: '0000_alter_busy', sql: 'ALTER TABLE busy ADD COLUMN label text;' },
    ]);
    const retries: MigrationLockRetryInfo[] = [];
    const started = Date.now();
    const failure = await applyMigrations({
      db,
      migrationsFolder: folder,
      lockTimeoutMs: 150,
      lockRetries: 1,
      lockRetryDelayMs: 50,
      onLockRetry: (info) => retries.push(info),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect((failure as MigrationLockTimeoutError).metadata).toMatchObject({
      tag: '0000_alter_busy',
      statement: 1,
      attempts: 2,
      lockTimeoutMs: 150,
      transactional: true,
    });
    expect(retries).toEqual([
      { tag: '0000_alter_busy', statement: 1, retry: 1, retries: 1, delayMs: 50 },
    ]);
    expect(await historyCount(sql)).toBe(0);
    const columns = await sql`
      SELECT 1 FROM information_schema.columns WHERE table_name = 'busy' AND column_name = 'label'
    `;
    expect(columns).toHaveLength(0);

    // The lock is gone: the same migration applies on the next run.
    await release();
    expect(await applyMigrations({ db, migrationsFolder: folder })).toEqual({
      applied: 1,
      tags: ['0000_alter_busy'],
    });
  }, 30_000);

  it('applies on a retry once the lock is released', async () => {
    const database = await testDatabase();
    const { sql, db } = client(database);
    await sql`CREATE TABLE busy (id int)`;
    const release = await holdReaderLock(database, 'busy');
    const releaseSoon = setTimeout(() => void release(), 400);
    cleanups.push(async () => clearTimeout(releaseSoon));

    const folder = writeMigrations([
      { tag: '0000_alter_busy', sql: 'ALTER TABLE busy ADD COLUMN label text;' },
    ]);
    const retries: MigrationLockRetryInfo[] = [];
    const result = await applyMigrations({
      db,
      migrationsFolder: folder,
      lockTimeoutMs: 150,
      lockRetries: 5,
      lockRetryDelayMs: 100,
      onLockRetry: (info) => retries.push(info),
    });

    expect(result).toEqual({ applied: 1, tags: ['0000_alter_busy'] });
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(await historyCount(sql)).toBe(1);
  }, 30_000);

  it('runs migration statements under a five-second lock_timeout by default and leaves the pooled connection unchanged', async () => {
    const database = await testDatabase();
    const { sql, db } = client(database);
    const folder = writeMigrations([
      {
        tag: '0000_probe',
        sql: "CREATE TABLE lt_probe AS SELECT current_setting('lock_timeout') AS value;",
      },
      {
        tag: '0001_probe_no_tx',
        sql: `${NO_TX}CREATE TABLE lt_probe_no_tx AS SELECT current_setting('lock_timeout') AS value;`,
      },
    ]);

    await applyMigrations({ db, migrationsFolder: folder });

    expect(await sql`SELECT value FROM lt_probe`).toEqual([{ value: '5s' }]);
    expect(await sql`SELECT value FROM lt_probe_no_tx`).toEqual([{ value: '5s' }]);
    // A pool of one: the same connection the run used, back at the server default.
    expect(await sql`SELECT current_setting('lock_timeout') AS value`).toEqual([{ value: '0' }]);
  }, 30_000);

  it('lockTimeoutMs 0 keeps the old wait-forever behaviour', async () => {
    const database = await testDatabase();
    const { sql, db } = client(database);
    const folder = writeMigrations([
      {
        tag: '0000_probe',
        sql: "CREATE TABLE lt_probe AS SELECT current_setting('lock_timeout') AS value;",
      },
    ]);
    await applyMigrations({ db, migrationsFolder: folder, lockTimeoutMs: 0 });
    expect(await sql`SELECT value FROM lt_probe`).toEqual([{ value: '0' }]);
  }, 30_000);

  it('rejects a lock policy that is not a whole number', async () => {
    const database = await testDatabase();
    const { db } = client(database);
    const folder = writeMigrations([{ tag: '0000_noop', sql: 'SELECT 1;' }]);
    await expect(
      applyMigrations({ db, migrationsFolder: folder, lockTimeoutMs: -1 }),
    ).rejects.toThrow('lockTimeoutMs must be a whole number');
    await expect(
      applyMigrations({ db, migrationsFolder: folder, lockRetries: 1.5 }),
    ).rejects.toThrow('lockRetries must be a whole number');
  }, 30_000);
});

describe('-- plumbus:no-transaction migrations', () => {
  it('reads the directive only from the leading comment block', async () => {
    const database = await testDatabase();
    const { db } = client(database);
    const folder = writeMigrations([
      { tag: '0000_marked', sql: `-- build the index without blocking writers\n${NO_TX}SELECT 1;` },
      { tag: '0001_after_statement', sql: `SELECT 1;\n${NO_TX}` },
      { tag: '0002_plain', sql: 'SELECT 2;' },
    ]);
    const pending = await readPendingMigrations({ db, migrationsFolder: folder });
    expect(pending.map((migration) => [migration.tag, migration.transactional])).toEqual([
      ['0000_marked', false],
      ['0001_after_statement', true],
      ['0002_plain', true],
    ]);
  }, 30_000);

  it('builds an index concurrently and records the migration', async () => {
    const database = await testDatabase();
    const { sql, db } = client(database);
    await sql`CREATE TABLE ledger (id int, ref text)`;
    await sql`INSERT INTO ledger SELECT g, 'r' || g FROM generate_series(1, 1000) g`;
    const folder = writeMigrations([
      {
        tag: '0000_ledger_ref_idx',
        sql: `${NO_TX}CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_ref_idx ON ledger (ref);`,
      },
    ]);

    expect(await applyMigrations({ db, migrationsFolder: folder })).toEqual({
      applied: 1,
      tags: ['0000_ledger_ref_idx'],
    });
    const indexes = await sql<Array<{ valid: boolean }>>`
      SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'ledger_ref_idx'
    `;
    expect(indexes).toEqual([{ valid: true }]);
    expect(await historyCount(sql)).toBe(1);
  }, 30_000);

  it('the same statement in a transactional migration is refused by PostgreSQL', async () => {
    const database = await testDatabase();
    const { sql, db } = client(database);
    await sql`CREATE TABLE ledger (id int, ref text)`;
    const folder = writeMigrations([
      {
        tag: '0000_ledger_ref_idx',
        sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_ref_idx ON ledger (ref);',
      },
    ]);
    const failure = await applyMigrations({ db, migrationsFolder: folder }).catch((e) => e);
    expect(failure).toBeInstanceOf(MigrationStatementError);
    expect(String((failure as Error).message)).toContain('cannot run inside a transaction block');
    expect(await historyCount(sql)).toBe(0);
  }, 30_000);

  it('drops the invalid index a failed concurrent build left, keeps the migration pending, and applies it on the next run', async () => {
    const database = await testDatabase();
    const { sql, db } = client(database);
    await sql`CREATE TABLE ledger (id int, ref text)`;
    await sql`INSERT INTO ledger VALUES (1, 'dup'), (2, 'dup'), (3, 'other')`;
    const folder = writeMigrations([
      {
        tag: '0000_ledger_ref_unique',
        sql:
          `${NO_TX}CREATE TABLE IF NOT EXISTS ledger_audit (id int);\n` +
          '--> statement-breakpoint\n' +
          'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ledger_ref_unique ON ledger (ref);',
      },
    ]);

    const failure = await applyMigrations({ db, migrationsFolder: folder }).catch((e) => e);
    expect(failure).toBeInstanceOf(MigrationStatementError);
    const error = failure as MigrationStatementError;
    expect(error.metadata).toMatchObject({
      tag: '0000_ledger_ref_unique',
      statement: 2,
      statements: 2,
      transactional: false,
      invalidIndexesDropped: ['public.ledger_ref_unique'],
    });
    expect(error.message).toContain('Statements 1-1 were committed');
    expect(error.message).toContain('still pending');
    expect(await listInvalidIndexes(db)).toEqual([]);
    expect(await historyCount(sql)).toBe(0);
    // Statement 1 committed on its own.
    expect(await sql`SELECT to_regclass('ledger_audit') IS NOT NULL AS present`).toEqual([
      { present: true },
    ]);

    await sql`DELETE FROM ledger WHERE id = 2`;
    expect(await applyMigrations({ db, migrationsFolder: folder })).toEqual({
      applied: 1,
      tags: ['0000_ledger_ref_unique'],
    });
    const indexes = await sql<Array<{ valid: boolean }>>`
      SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'ledger_ref_unique'
    `;
    expect(indexes).toEqual([{ valid: true }]);
  }, 30_000);

  it('refuses to record a migration while an invalid index from an earlier crashed run is still there', async () => {
    const database = await testDatabase();
    const { sql, db } = client(database);
    await sql`CREATE TABLE ledger (id int, ref text)`;
    await sql`INSERT INTO ledger VALUES (1, 'dup'), (2, 'dup')`;
    // What a run that died mid-build leaves: the index exists and is invalid.
    await sql
      .unsafe('CREATE UNIQUE INDEX CONCURRENTLY ledger_ref_unique ON ledger (ref)')
      .catch(() => undefined);
    await sql`DELETE FROM ledger WHERE id = 2`;
    expect((await listInvalidIndexes(db)).map((index) => index.name)).toEqual([
      'ledger_ref_unique',
    ]);

    const folder = writeMigrations([
      {
        tag: '0000_ledger_ref_unique',
        sql: `${NO_TX}CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ledger_ref_unique ON ledger (ref);`,
      },
    ]);
    // IF NOT EXISTS skips the broken index; the runner notices and does not record.
    const failure = await applyMigrations({ db, migrationsFolder: folder }).catch((e) => e);
    expect(failure).toBeInstanceOf(MigrationInvalidIndexError);
    expect((failure as MigrationInvalidIndexError).invalidIndexes.map((i) => i.name)).toEqual([
      'ledger_ref_unique',
    ]);
    expect(await historyCount(sql)).toBe(0);

    await sql`DROP INDEX CONCURRENTLY ledger_ref_unique`;
    expect(await applyMigrations({ db, migrationsFolder: folder })).toEqual({
      applied: 1,
      tags: ['0000_ledger_ref_unique'],
    });
    expect(await listInvalidIndexes(db)).toEqual([]);
  }, 30_000);

  it('a concurrent run waiting for the migration lock does not stall a concurrent index build', async () => {
    const database = await testDatabase();
    const first = client(database);
    const second = client(database);
    await first.sql`CREATE TABLE ledger (id int, ref text)`;
    const folder = writeMigrations([
      // Holds the migration lock long enough for the second run to arrive and wait.
      { tag: '0000_slow', sql: 'SELECT pg_sleep(0.6);' },
      {
        tag: '0001_ledger_ref_idx',
        sql: `${NO_TX}CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_ref_idx ON ledger (ref);`,
      },
    ]);

    let waited = false;
    const firstRun = applyMigrations({ db: first.db, migrationsFolder: folder });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const secondRun = applyMigrations({
      db: second.db,
      migrationsFolder: folder,
      onLockWait: () => {
        waited = true;
      },
    });

    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
    expect(waited).toBe(true);
    expect(firstResult).toEqual({ applied: 2, tags: ['0000_slow', '0001_ledger_ref_idx'] });
    expect(secondResult).toEqual({ applied: 0, tags: [] });
    expect(await listInvalidIndexes(first.db)).toEqual([]);
  }, 30_000);
});
