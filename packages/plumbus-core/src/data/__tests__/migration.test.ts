import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getTableName } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { field } from '../../fields/index.js';
import { generateDrizzleSchema } from '../schema-generator.js';
import type { EntityDefinition } from '../../types/entity.js';
import {
  collectSchemas,
  readPendingMigrations,
  reconcileMigrationHistory,
  rollbackLastMigration,
} from '../migration.js';

function makeEntity(name: string): EntityDefinition {
  return {
    name,
    fields: {
      id: field.id(),
      label: field.string({ required: true }),
    },
  };
}

function getSchema(schemas: Record<string, PgTableWithColumns<any>>, key: string) {
  const table = schemas[key];
  expect(table).toBeDefined();
  return table as PgTableWithColumns<any>;
}

function writeMigrationFixture(
  baseDir: string,
  files: Array<{ tag: string; sql: string; when: number }>,
) {
  const metaDir = path.join(baseDir, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });

  for (const file of files) {
    fs.writeFileSync(path.join(baseDir, `${file.tag}.sql`), file.sql, 'utf-8');
  }

  fs.writeFileSync(
    path.join(metaDir, '_journal.json'),
    JSON.stringify(
      {
        entries: files.map((file, index) => ({
          idx: index,
          version: '7',
          when: file.when,
          tag: file.tag,
          breakpoints: true,
        })),
      },
      null,
      2,
    ),
    'utf-8',
  );
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('collectSchemas', () => {
  it('includes user-defined entity tables', () => {
    const schemas = collectSchemas([makeEntity('Order'), makeEntity('Customer')]);
    expect(schemas.Order).toBeDefined();
    expect(schemas.Customer).toBeDefined();
  });

  it('includes the audit_records framework table', () => {
    const schemas = collectSchemas([]);
    expect(getTableName(getSchema(schemas, '__audit_records'))).toBe('audit_records');
  });

  it('includes event outbox framework tables', () => {
    const schemas = collectSchemas([]);
    expect(getTableName(getSchema(schemas, '__event_outbox'))).toBe('event_outbox');
    expect(getTableName(getSchema(schemas, '__event_idempotency'))).toBe('event_idempotency');
    expect(getTableName(getSchema(schemas, '__event_dead_letter'))).toBe('event_dead_letter');
  });

  it('includes flow framework tables', () => {
    const schemas = collectSchemas([]);
    expect(getTableName(getSchema(schemas, '__flow_executions'))).toBe('flow_executions');
    expect(getTableName(getSchema(schemas, '__flow_dead_letter'))).toBe('flow_dead_letter');
    expect(getTableName(getSchema(schemas, '__flow_schedules'))).toBe('flow_schedules');
  });

  it('includes RAG document tables', () => {
    const schemas = collectSchemas([]);
    expect(getTableName(getSchema(schemas, '__documents'))).toBe('documents');
    expect(getTableName(getSchema(schemas, '__document_chunks'))).toBe('document_chunks');
  });

  it('includes all 10 framework tables with zero entities', () => {
    const schemas = collectSchemas([]);
    const frameworkKeys = Object.keys(schemas).filter((k) => k.startsWith('__'));
    expect(frameworkKeys).toHaveLength(10);
  });

  it('throws when an extra schema collides with an entity table name', () => {
    const entity = makeEntity('Order');
    const entityTable = generateDrizzleSchema(entity);
    const duplicate = pgTable(getTableName(entityTable), {
      id: uuid('id').primaryKey(),
    });
    expect(() => collectSchemas([entity], { authSessions: duplicate })).toThrow(
      /Migration schema collision/,
    );
  });
});

describe('migration history helpers', () => {
  it('reads only unapplied migrations from the journal', async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migrations-'));
    tempDirs.push(migrationsDir);

    const firstSql = 'CREATE TABLE "orders" ("id" uuid PRIMARY KEY);';
    const secondSql = [
      'ALTER TABLE "orders" ADD COLUMN "slug" text;',
      '--> statement-breakpoint',
      'CREATE INDEX "orders_slug_idx" ON "orders" ("slug");',
    ].join('\n');

    writeMigrationFixture(migrationsDir, [
      { tag: '0001_init', sql: firstSql, when: 1000 },
      { tag: '0002_slug', sql: secondSql, when: 2000 },
    ]);

    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([]) // CREATE SCHEMA IF NOT EXISTS "drizzle"
        .mockResolvedValueOnce([]) // CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"
        .mockResolvedValueOnce([]) // legacy public.__drizzle_migrations existence check
        .mockResolvedValueOnce([{ hash: sha256(firstSql) }]),
    };

    const pending = await readPendingMigrations({
      db: db as any,
      migrationsFolder: migrationsDir,
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.tag).toBe('0002_slug');
    expect(pending[0]?.statements).toHaveLength(2);
  });

  it('skips legacy migration adoption when public tracking table is absent', async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migrations-'));
    tempDirs.push(migrationsDir);

    const firstSql = 'CREATE TABLE "orders" ("id" uuid PRIMARY KEY);';
    writeMigrationFixture(migrationsDir, [{ tag: '0001_init', sql: firstSql, when: 1000 }]);

    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // CREATE SCHEMA IF NOT EXISTS "drizzle"
      .mockResolvedValueOnce([]) // CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"
      .mockResolvedValueOnce([]) // legacy public.__drizzle_migrations existence check (absent)
      .mockResolvedValueOnce([]); // applied hashes

    const pending = await readPendingMigrations({
      db: { execute } as any,
      migrationsFolder: migrationsDir,
    });

    expect(pending).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('reconciles only missing migration records', async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migrations-'));
    tempDirs.push(migrationsDir);

    const firstSql = 'CREATE TABLE "orders" ("id" uuid PRIMARY KEY);';
    const secondSql = 'ALTER TABLE "orders" ADD COLUMN "slug" text;';

    writeMigrationFixture(migrationsDir, [
      { tag: '0001_init', sql: firstSql, when: 1000 },
      { tag: '0002_slug', sql: secondSql, when: 2000 },
    ]);

    const tx = {
      execute: vi.fn(async () => []),
    };
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([]) // CREATE SCHEMA IF NOT EXISTS "drizzle"
        .mockResolvedValueOnce([]) // CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"
        .mockResolvedValueOnce([]) // legacy public.__drizzle_migrations existence check
        .mockResolvedValueOnce([{ hash: sha256(firstSql) }]),
      transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };

    const result = await reconcileMigrationHistory({
      db: db as any,
      migrationsFolder: migrationsDir,
    });

    expect(result).toEqual({
      adopted: 1,
      alreadyApplied: 1,
      adoptedTags: ['0002_slug'],
    });
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
});

describe('rollbackLastMigration', () => {
  const dialect = new PgDialect();

  /**
   * `ensureMigrationsTable` issues three statements before any caller query:
   * CREATE SCHEMA, CREATE TABLE, and the legacy-table existence probe.
   */
  function ensureMigrationsTableCalls() {
    return [[], [], []] as const;
  }

  function buildQuery(query: unknown) {
    // Mirrors what PgDatabase.execute does with its argument. A plain
    // `{ sql, params }` object has no getSQL() and blows up here — that is the
    // exact shape this function used to pass to the driver.
    return dialect.sqlToQuery((query as SQL).getSQL());
  }

  it('deletes the newest history row and reports its journal tag', async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migrations-'));
    tempDirs.push(migrationsDir);

    const firstSql = 'CREATE TABLE "orders" ("id" uuid PRIMARY KEY);';
    const secondSql = 'ALTER TABLE "orders" ADD COLUMN "slug" text;';
    writeMigrationFixture(migrationsDir, [
      { tag: '0001_init', sql: firstSql, when: 1000 },
      { tag: '0002_slug', sql: secondSql, when: 2000 },
    ]);

    const execute = vi.fn();
    for (const call of ensureMigrationsTableCalls()) {
      execute.mockResolvedValueOnce(call);
    }
    execute
      .mockResolvedValueOnce([{ id: 7, hash: sha256(secondSql) }]) // newest history row
      .mockResolvedValueOnce([]); // DELETE

    const result = await rollbackLastMigration({
      db: { execute } as any,
      migrationsFolder: migrationsDir,
    });

    expect(result).toEqual({
      status: 'rolled_back',
      rolledBack: '0002_slug',
      tag: '0002_slug',
      hash: sha256(secondSql),
    });

    const select = buildQuery(execute.mock.calls[3]?.[0]);
    expect(select.sql).toContain('"drizzle"."__drizzle_migrations"');
    expect(select.sql).toContain('ORDER BY created_at DESC NULLS LAST');

    // Deleting by id keeps a duplicated hash from taking unrelated rows with it,
    // and the value must travel as a bound parameter, not string interpolation.
    const del = buildQuery(execute.mock.calls[4]?.[0]);
    expect(del.sql).toContain('DELETE FROM "drizzle"."__drizzle_migrations" WHERE id =');
    expect(del.params).toEqual([7]);
  });

  it('reports no_migrations on an empty history without issuing a delete', async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migrations-'));
    tempDirs.push(migrationsDir);
    writeMigrationFixture(migrationsDir, [
      { tag: '0001_init', sql: 'CREATE TABLE "orders" ("id" uuid PRIMARY KEY);', when: 1000 },
    ]);

    const execute = vi.fn();
    for (const call of ensureMigrationsTableCalls()) {
      execute.mockResolvedValueOnce(call);
    }
    execute.mockResolvedValueOnce([]); // no history rows

    const result = await rollbackLastMigration({
      db: { execute } as any,
      migrationsFolder: migrationsDir,
    });

    expect(result).toEqual({
      status: 'no_migrations',
      rolledBack: null,
      tag: null,
      hash: null,
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('falls back to the hash when the journal no longer describes the migration', async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migrations-'));
    tempDirs.push(migrationsDir);
    // No journal written at all — history rows outlive the files that made them.

    const orphanHash = sha256('CREATE TABLE "gone" ("id" uuid PRIMARY KEY);');
    const execute = vi.fn();
    for (const call of ensureMigrationsTableCalls()) {
      execute.mockResolvedValueOnce(call);
    }
    execute.mockResolvedValueOnce([{ id: 3, hash: orphanHash }]).mockResolvedValueOnce([]);

    const result = await rollbackLastMigration({
      db: { execute } as any,
      migrationsFolder: migrationsDir,
    });

    expect(result).toEqual({
      status: 'rolled_back',
      rolledBack: orphanHash,
      tag: null,
      hash: orphanHash,
    });
  });

  it('creates the history table first so an unmigrated database does not error', async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-migrations-'));
    tempDirs.push(migrationsDir);

    const execute = vi.fn().mockResolvedValue([]);

    await rollbackLastMigration({ db: { execute } as any, migrationsFolder: migrationsDir });

    const createSchema = buildQuery(execute.mock.calls[0]?.[0]);
    const createTable = buildQuery(execute.mock.calls[1]?.[0]);
    expect(createSchema.sql).toContain('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    expect(createTable.sql).toContain(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"',
    );
  });
});
