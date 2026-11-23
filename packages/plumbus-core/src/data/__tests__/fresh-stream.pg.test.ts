// A brand-new app's first generated migration stream, applied to an empty database: does it
// create the framework schema (`core_plumbus`) itself?

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineEntity } from '../../define/defineEntity.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { field } from '../../fields/index.js';
import { rewriteFrameworkDriftMigration } from '../framework-migration-rewriter.js';
import { applyMigrations, collectSchemas } from '../migration.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("a new app's first generated stream", () => {
  it('applies to an empty database', async () => {
    const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
    const entity = defineEntity({
      name: 'Invoice',
      fields: { id: field.id(), number: field.string({ required: true }) },
    });
    const schemas = collectSchemas([entity] as never);
    const raw = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schemas));
    const statements = rewriteFrameworkDriftMigration(
      raw,
      { hasDrift: false, existingFrameworkTables: [], missingFrameworkTables: [], tables: [] },
      schemas,
    ).statements;
    const handle = await createDurableTestDatabase({ kind: 'fresh_stream', ddl: '' });
    closers.push(() => handle.close());
    // The files `plumbus migrate generate` writes.
    const outDir = fs.mkdtempSync(path.join(tmpdir(), 'plumbus-fresh-stream-'));
    closers.push(async () => fs.rmSync(outDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(outDir, 'meta'));
    const tag = '00000000001000_migration';
    fs.writeFileSync(path.join(outDir, `${tag}.sql`), statements.join('\n'));
    fs.writeFileSync(
      path.join(outDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: 1000, tag, breakpoints: true }],
      }),
    );
    const result = await applyMigrations({ db: handle.db, migrationsFolder: outDir });
    expect(result.tags).toEqual([tag]);
  });
});
