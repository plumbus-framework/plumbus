// Concurrent `applyMigrations` / `applyDataPlaneMigrations` runs against a real Postgres:
// the migration advisory lock serialises them and the history hash is unique.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createDurableTestDatabase, resolveTestPostgresAdmin } from '../../durable/index.js';
import { applyDataPlaneMigrations } from '../../tenancy/index.js';
import {
  applyMigrations,
  MIGRATION_ADVISORY_LOCK_KEY,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migration-lock-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'meta'));
  for (const file of files) {
    fs.writeFileSync(path.join(dir, `${file.tag}.sql`), file.sql);
  }
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
  const database = await createDurableTestDatabase({ admin, kind: 'migration_lock', ddl: '' });
  cleanups.push(() => database.close());
  return database.name;
}

/** A pool of one, like `applyDataPlaneMigrations` and a migrate Job. */
function client(database: string) {
  const sql = postgres({
    host: admin.host,
    port: admin.port,
    database,
    username: admin.user,
    password: admin.password,
    max: 1,
    onnotice: () => {},
  });
  cleanups.push(() => sql.end({ timeout: 5 }));
  return { sql, db: drizzle(sql) };
}

async function advisoryLocks(
  probe: postgres.Sql,
  database: string,
): Promise<Array<{ granted: boolean }>> {
  // A bigint advisory key is split into classid (high 32 bits) and objid (low 32 bits).
  return probe<Array<{ granted: boolean }>>`
    SELECT l.granted
    FROM pg_locks l
    JOIN pg_database d ON d.oid = l.database
    WHERE l.locktype = 'advisory'
      AND d.datname = ${database}
      AND l.objsubid = 1
      AND ((l.classid::bigint << 32) | l.objid::bigint) = ${MIGRATION_ADVISORY_LOCK_KEY}::bigint
  `;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const SLOW_FIRST = [
  // The first migration sleeps inside its transaction so the second run arrives mid-apply.
  { tag: '0000_first', sql: 'CREATE TABLE lock_probe (id int);\nSELECT pg_sleep(0.6);' },
  { tag: '0001_second', sql: 'ALTER TABLE lock_probe ADD COLUMN label text;' },
];

describe('migration advisory lock', () => {
  it('serialises two concurrent applies: one applies, the other waits then finds nothing pending', async () => {
    const database = await testDatabase();
    const folder = writeMigrations(SLOW_FIRST);
    const first = client(database);
    const second = client(database);
    const probe = client(database).sql;

    const firstRun = applyMigrations({ db: first.db, migrationsFolder: folder });
    await until(
      async () => (await advisoryLocks(probe, database)).some((lock) => lock.granted),
      'the first run to hold the lock',
    );

    let waited = false;
    const secondRun = applyMigrations({
      db: second.db,
      migrationsFolder: folder,
      onLockWait: () => {
        waited = true;
      },
    });
    await until(
      async () => (await advisoryLocks(probe, database)).some((lock) => !lock.granted),
      'the second run to wait on the lock',
    );

    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
    expect(firstResult).toEqual({ applied: 2, tags: ['0000_first', '0001_second'] });
    expect(secondResult).toEqual({ applied: 0, tags: [] });
    expect(waited).toBe(true);

    const history = await probe<Array<{ hash: string }>>`
      SELECT hash FROM "drizzle"."__drizzle_migrations"
    `;
    expect(history).toHaveLength(2);
    expect(await advisoryLocks(probe, database)).toEqual([]);
  }, 30_000);

  it('serialises concurrent applyDataPlaneMigrations runs on a pool of one', async () => {
    const database = await testDatabase();
    const folder = writeMigrations(SLOW_FIRST);
    const target = {
      host: admin.host,
      port: admin.port,
      database,
      user: admin.user,
      password: admin.password,
    };

    const results = await Promise.all([
      applyDataPlaneMigrations({ target, migrationsFolder: folder }),
      applyDataPlaneMigrations({ target, migrationsFolder: folder }),
      applyDataPlaneMigrations({ target, migrationsFolder: folder }),
    ]);

    expect(results.map((result) => result.applied).sort()).toEqual([0, 0, 2]);
    const probe = client(database).sql;
    const history = await probe`SELECT hash FROM "drizzle"."__drizzle_migrations"`;
    expect(history).toHaveLength(2);
  }, 30_000);

  it('releases the lock when a migration fails, so the next run can apply', async () => {
    const database = await testDatabase();
    const failing = writeMigrations([{ tag: '0000_bad', sql: 'SELECT missing_function();' }]);
    const { db, sql } = client(database);

    await expect(applyMigrations({ db, migrationsFolder: failing })).rejects.toThrow(
      'missing_function',
    );
    expect(await advisoryLocks(sql, database)).toEqual([]);

    const fixed = writeMigrations([{ tag: '0000_good', sql: 'SELECT 1;' }]);
    expect(await applyMigrations({ db, migrationsFolder: fixed })).toEqual({
      applied: 1,
      tags: ['0000_good'],
    });
  }, 30_000);
});

describe('unique migration history hash', () => {
  it('collapses duplicate rows in an existing history table and adds the unique index', async () => {
    const database = await testDatabase();
    const { db, sql } = client(database);
    // The pre-0.9.0-beta.1 table shape, with a migration recorded twice by an unlocked race.
    await sql.unsafe(`
      CREATE SCHEMA "drizzle";
      CREATE TABLE "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT
      );
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES ('aaa', 1), ('aaa', 1), ('bbb', 2);
    `);
    const folder = writeMigrations([{ tag: '0000_noop', sql: 'SELECT 1;' }]);

    await readPendingMigrations({ db, migrationsFolder: folder });

    const rows = await sql<Array<{ id: number; hash: string }>>`
      SELECT id, hash FROM "drizzle"."__drizzle_migrations" ORDER BY id
    `;
    expect(rows).toEqual([
      { id: 1, hash: 'aaa' },
      { id: 3, hash: 'bbb' },
    ]);
    await expect(
      sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('bbb', 3)`,
    ).rejects.toMatchObject({ code: '23505' });
  }, 30_000);

  it('records a journal entry whose SQL repeats an earlier one only once', async () => {
    const database = await testDatabase();
    const { db, sql } = client(database);
    const folder = writeMigrations([
      { tag: '0000_custom', sql: '-- Custom SQL migration file\n' },
      { tag: '0001_custom', sql: '-- Custom SQL migration file\n' },
    ]);

    expect(await applyMigrations({ db, migrationsFolder: folder })).toEqual({
      applied: 1,
      tags: ['0000_custom'],
    });
    expect(await sql`SELECT hash FROM "drizzle"."__drizzle_migrations"`).toHaveLength(1);
  }, 30_000);
});
