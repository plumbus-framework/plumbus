// Entity indexes beyond plain fields (framework columns, sort order, expressions, partial,
// operator classes) and hand-written migrations (`plumbus migrate new`) in one generated stream,
// applied to a real PostgreSQL: the indexes exist as declared and the planner uses them, the
// hand-written SQL runs in journal order, and a later `generate` neither repeats nor undoes it.

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createHandWrittenMigration, nextMigrationTimestamp } from '../../cli/commands/migrate.js';
import { defineEntity } from '../../define/defineEntity.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { field } from '../../fields/index.js';
import { rewriteFrameworkDriftMigration } from '../framework-migration-rewriter.js';
import { applyMigrations, collectSchemas } from '../migration.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function account(extraField = false) {
  return defineEntity({
    name: 'Account',
    tenantScoped: true,
    fields: {
      id: field.id(),
      displayName: field.string({ required: true }),
      email: field.string(),
      state: field.string({ required: true }),
      ...(extraField ? { nickname: field.string() } : {}),
    },
    indexes: [
      // Newest first within a tenant, on framework columns.
      {
        columns: ['tenantId', 'createdAt', 'id'],
        columnOptions: { createdAt: { order: 'desc' }, id: { order: 'desc' } },
      },
      // Case-insensitive sort and lookup.
      { columns: [], expressions: ['lower(display_name)'], name: 'account_display_name_lower_idx' },
      // Only the rows a sweep reads.
      { columns: ['state'], where: "state = 'pending'", name: 'account_pending_idx' },
      // Substring search, served by pg_trgm (created by the hand-written migration).
      {
        columns: ['displayName'],
        columnOptions: { displayName: { opclass: 'gin_trgm_ops' } },
        using: 'gin',
        name: 'account_display_name_trgm_idx',
      },
    ],
  });
}

/** What `plumbus migrate generate` does with the files: diff from the last snapshot. */
async function generate(outDir: string, entities: ReturnType<typeof account>[], now: number) {
  const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
  const metaDir = path.join(outDir, 'meta');
  const files = fs
    .readdirSync(metaDir)
    .filter((file) => file.endsWith('.json') && file !== '_journal.json')
    .sort();
  const lastFile = files[files.length - 1];
  const previous = lastFile
    ? JSON.parse(fs.readFileSync(path.join(metaDir, lastFile), 'utf-8'))
    : generateDrizzleJson({});
  const schemas = collectSchemas(entities as never);
  const current = generateDrizzleJson(schemas, previous.prevId ?? previous.id);
  const raw = await generateMigration(previous, current);
  if (raw.length === 0) return [];
  // As `generate` does: the framework rewrite (schema creation, idempotent DDL).
  const statements = rewriteFrameworkDriftMigration(
    raw,
    { hasDrift: false, existingFrameworkTables: [], missingFrameworkTables: [], tables: [] },
    schemas,
  ).statements;
  const tag = `${String(now).padStart(14, '0')}_migration`;
  fs.writeFileSync(path.join(outDir, `${tag}.sql`), statements.join('\n'));
  fs.writeFileSync(path.join(metaDir, `${tag}.json`), JSON.stringify(current, null, 2));
  const journalPath = path.join(metaDir, '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
  journal.entries.push({
    idx: journal.entries.length,
    version: '7',
    when: now,
    tag,
    breakpoints: true,
  });
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return statements;
}

async function writeSql(file: string, statements: string[]) {
  fs.appendFileSync(file, statements.join('\n--> statement-breakpoint\n'));
}

describe('entity indexes and hand-written migrations in one generated stream', () => {
  it('applies extension, generated indexes, trigger, framework-table index and storage settings', async () => {
    const outDir = fs.mkdtempSync(path.join(tmpdir(), 'plumbus-hand-written-'));
    closers.push(async () => fs.rmSync(outDir, { recursive: true, force: true }));
    const handle = await createDurableTestDatabase({ kind: 'hand_written', ddl: '' });
    closers.push(() => handle.close());
    const db = handle.db;

    // 1. Hand-written first: the extension the trigram index needs.
    const extension = await createHandWrittenMigration(outDir, 'Enable trigram search', {
      now: 1_000,
    });
    await writeSql(extension.file, [
      'CREATE EXTENSION IF NOT EXISTS pg_trgm',
      // The framework schema, as an app's first stream file provides it.
      'CREATE SCHEMA IF NOT EXISTS core_plumbus',
    ]);
    // 2. Generated: the entity, its indexes and the framework tables.
    const generated = await generate(outDir, [account()], 2_000);
    expect(generated.join('\n')).toContain('lower(display_name)');
    expect(generated.join('\n')).toContain('gin_trgm_ops');
    // 3. Hand-written after it: a counter kept by a trigger, an index on a framework table,
    //    per-table autovacuum settings.
    const extras = await createHandWrittenMigration(
      outDir,
      'account counter, approval history, vacuum',
      { now: 3_000 },
    );
    await writeSql(extras.file, [
      'CREATE TABLE account_count (tenant_id text PRIMARY KEY, n bigint NOT NULL)',
      `CREATE FUNCTION account_count_bump() RETURNS trigger AS $$
       BEGIN
         INSERT INTO account_count (tenant_id, n) VALUES (NEW.tenant_id, 1)
         ON CONFLICT (tenant_id) DO UPDATE SET n = account_count.n + 1;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
      'CREATE TRIGGER account_count_bump AFTER INSERT ON account FOR EACH ROW EXECUTE FUNCTION account_count_bump()',
      'CREATE INDEX approval_request_history_idx ON core_plumbus.approval_request (updated_at DESC, approval_request_id DESC)',
      'ALTER TABLE account SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)',
    ]);
    // 4. A later generate: nothing to do without an entity change (the hand-written work is not
    //    repeated or undone), then only the new field.
    expect(await generate(outDir, [account()], 4_000)).toEqual([]);
    const next = await generate(outDir, [account(true)], 5_000);
    expect(next.join('\n')).toMatch(/ADD COLUMN (IF NOT EXISTS )?"nickname"/);
    expect(next.join('\n')).not.toMatch(/CREATE (TABLE|INDEX)|DROP/);
    // A non-transactional hand-written migration (CONCURRENTLY).
    const concurrent = await createHandWrittenMigration(outDir, 'email lookup', {
      noTransaction: true,
      now: 6_000,
    });
    expect(fs.readFileSync(concurrent.file, 'utf-8').startsWith('-- plumbus:no-transaction')).toBe(
      true,
    );
    await writeSql(concurrent.file, [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS account_email_idx ON account (email)',
    ]);

    const result = await applyMigrations({ db, migrationsFolder: outDir });
    expect(result.tags).toEqual([
      extension.tag,
      '00000000002000_migration',
      extras.tag,
      '00000000005000_migration',
      concurrent.tag,
    ]);

    const indexes = (await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('account', 'approval_request')
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    const def = (name: string) => indexes.find((row) => row.indexname === name)?.indexdef ?? '';
    expect(def('account_tenant_id_created_at_id_idx')).toMatch(
      /\(tenant_id, created_at DESC, id DESC\)/,
    );
    expect(def('account_display_name_lower_idx')).toMatch(/lower\(display_name\)/);
    expect(def('account_pending_idx')).toMatch(/WHERE \(state = 'pending'::text\)/);
    expect(def('account_display_name_trgm_idx')).toMatch(/USING gin \(display_name gin_trgm_ops\)/);
    expect(def('approval_request_history_idx')).toMatch(
      /updated_at DESC, approval_request_id DESC/,
    );
    expect(def('account_email_idx')).toMatch(/\(email\)/);

    // The trigger runs; the storage settings are set.
    await db.execute(sql`
      INSERT INTO account (id, tenant_id, display_name, state)
      SELECT gen_random_uuid(), 't1', 'Name ' || g, CASE WHEN g % 50 = 0 THEN 'pending' ELSE 'active' END
      FROM generate_series(1, 2000) g
    `);
    const [count] = (await db.execute(
      sql`SELECT n FROM account_count WHERE tenant_id = 't1'`,
    )) as unknown as Array<{ n: string }>;
    expect(Number(count?.n)).toBe(2000);
    const [options] = (await db.execute(
      sql`SELECT reloptions FROM pg_class WHERE relname = 'account'`,
    )) as unknown as Array<{ reloptions: string[] }>;
    expect(options?.reloptions).toEqual(
      expect.arrayContaining([
        'autovacuum_vacuum_scale_factor=0.02',
        'autovacuum_analyze_scale_factor=0.01',
      ]),
    );

    // The planner uses each index for the query it exists for.
    await db.execute(sql`ANALYZE account`);
    const plan = async (query: ReturnType<typeof sql>) =>
      (
        (await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL enable_seqscan = off`);
          return tx.execute(sql`EXPLAIN ${query}`);
        })) as unknown as Record<string, string>[]
      )
        .map((row) => row['QUERY PLAN'])
        .join('\n');
    expect(
      await plan(
        sql`SELECT id FROM account WHERE tenant_id = 't1' ORDER BY created_at DESC, id DESC LIMIT 20`,
      ),
    ).toContain('account_tenant_id_created_at_id_idx');
    expect(await plan(sql`SELECT id FROM account ORDER BY lower(display_name) LIMIT 20`)).toContain(
      'account_display_name_lower_idx',
    );
    expect(await plan(sql`SELECT id FROM account WHERE state = 'pending'`)).toContain(
      'account_pending_idx',
    );
    expect(await plan(sql`SELECT id FROM account WHERE display_name ILIKE '%ame 1%'`)).toContain(
      'account_display_name_trgm_idx',
    );
  }, 60_000);

  it('refuses a migration name without letters or digits', async () => {
    const outDir = fs.mkdtempSync(path.join(tmpdir(), 'plumbus-hand-written-'));
    closers.push(async () => fs.rmSync(outDir, { recursive: true, force: true }));
    await expect(createHandWrittenMigration(outDir, '  --  ')).rejects.toThrow(/letters or digits/);
  });
});

describe('the tag a new migration gets', () => {
  it('comes after every journal entry, even one dated ahead of the clock', () => {
    const outDir = fs.mkdtempSync(path.join(tmpdir(), 'plumbus-next-tag-'));
    try {
      const journal = path.join(outDir, '_journal.json');
      expect(nextMigrationTimestamp(journal, 5_000)).toBe(5_000);
      fs.writeFileSync(journal, JSON.stringify({ entries: [{ when: 1_000 }, { when: 9_000 }] }));
      expect(nextMigrationTimestamp(journal, 5_000)).toBe(9_001);
      expect(nextMigrationTimestamp(journal, 20_000)).toBe(20_000);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
