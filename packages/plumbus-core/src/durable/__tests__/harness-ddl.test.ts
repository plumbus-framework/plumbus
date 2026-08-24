import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { FRAMEWORK_SCHEMA } from '../../data/schema-generator.js';
import { DURABLE_TEST_DB_PATTERN } from '../apply-ddl.js';
import { createDurableTestHarness, type DurableTestHarness } from '../harness.js';

describe('Two-database durable test harness DDL', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('creates dedicated databases, applies tenant and spine DDL, and names only plumbus_durable_test_*', async () => {
    harness = await createDurableTestHarness();
    expect(harness.spineName).toMatch(DURABLE_TEST_DB_PATTERN);
    expect(harness.tenantName).toMatch(DURABLE_TEST_DB_PATTERN);

    const tenantTables = await harness.tenantDb.execute(sql`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = ${FRAMEWORK_SCHEMA}
      ORDER BY table_name
    `);
    const names = (tenantTables as unknown as Array<{ table_name: string }>).map(
      (row) => row.table_name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'dispatch_outbox',
        'execution_state',
        'side_effect_log',
        'step_execution',
        'terminal_state',
        'wait_state',
      ]),
    );

    const spineTables = await harness.spineDb.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'opaque_dispatch'
    `);
    expect((spineTables as unknown as unknown[]).length).toBe(1);

    const spineCols = await harness.spineDb.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'opaque_dispatch'
    `);
    const columns = (spineCols as unknown as Array<{ column_name: string }>).map(
      (row) => row.column_name,
    );
    expect(columns).toContain('expected_revision');
    expect(columns).toContain('tenant_epoch');
    expect(columns).not.toContain('payload');
    expect(columns).not.toContain('input');
  });
});
