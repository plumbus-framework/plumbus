// `request_idempotency` reaches an application's own migration streams: `plumbus migrate
// generate` (collectSchemas) emits it in the framework schema, and the generated table is the
// table `requestIdempotencyDdl()` creates, so a database that already has it from the shipped
// SQL shows no drift and is not created twice.

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRAMEWORK_TABLE_NAMES, inspectFrameworkDrift } from '../../data/drift-inspector.js';
import { collectSchemas } from '../../data/migration.js';
import { startPostgres } from '../../flows/__tests__/postgres-fixture.js';
import { requestIdempotencyDdl } from '../database-idempotency-store.js';

let pg: Awaited<ReturnType<typeof startPostgres>>;

beforeAll(async () => {
  pg = await startPostgres();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('request_idempotency in generated migrations', () => {
  it('is a framework table that generate emits in core_plumbus, with its expiry index', async () => {
    expect(FRAMEWORK_TABLE_NAMES).toContain('request_idempotency');
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(collectSchemas([])),
    );
    const create = statements.find((s) => s.includes('"core_plumbus"."request_idempotency"'));
    expect(create).toMatch(/CREATE TABLE "core_plumbus"\."request_idempotency"/);
    expect(statements.some((s) => /CREATE INDEX "request_idempotency_expires_idx"/.test(s))).toBe(
      true,
    );
  });

  it('matches the shipped DDL column for column: a plane migrated by hand shows no drift', async () => {
    await pg.sql.unsafe(
      `CREATE SCHEMA IF NOT EXISTS core_plumbus;\n${requestIdempotencyDdl('core_plumbus')}`,
    );
    const report = await inspectFrameworkDrift(pg.db, []);
    expect(report.existingFrameworkTables).toContain('request_idempotency');
    const table = report.tables.find((t) => t.tableName === 'request_idempotency');
    expect(table).toEqual({ tableName: 'request_idempotency', exists: true, columnDrifts: [] });
  });
});
