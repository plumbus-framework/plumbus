import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getTableName } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { field } from '../../fields/index.js';
import type { EntityDefinition } from '../../types/entity.js';
import { collectSchemas, readPendingMigrations, reconcileMigrationHistory } from '../migration.js';

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
        .mockResolvedValueOnce([]) // adopt legacy public.__drizzle_migrations
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
        .mockResolvedValueOnce([]) // adopt legacy public.__drizzle_migrations
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
