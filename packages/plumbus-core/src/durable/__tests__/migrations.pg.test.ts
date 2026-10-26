import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { applyMigrations } from '../../data/migration.js';
import { DURABLE_TEST_DB_PATTERN } from '../apply-ddl.js';
import { createDurableTestDatabase } from '../harness.js';
import {
  FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
  FRAMEWORK_SPINE_MIGRATIONS,
} from '../migrations-path.js';

describe('Shipped durable SQL migrations', () => {
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const close of closers.reverse()) {
      await close();
    }
  });

  it('applies tenant durable and spine journals on dedicated plumbus_durable_test_* DBs', async () => {
    const tenant = await createDurableTestDatabase({ kind: 'migten', ddl: '' });
    closers.push(tenant.close);
    const spine = await createDurableTestDatabase({ kind: 'migspine', ddl: '' });
    closers.push(spine.close);

    expect(tenant.name).toMatch(DURABLE_TEST_DB_PATTERN);
    expect(spine.name).toMatch(DURABLE_TEST_DB_PATTERN);

    const tenantResult = await applyMigrations({
      db: tenant.db,
      migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
    });
    expect(tenantResult.applied).toBe(5);
    expect(tenantResult.tags).toEqual([
      '0000_durable_tenant',
      '0001_human_task',
      '0002_approval_cancellation',
      '0003_request_idempotency',
      '0004_claim_and_retention_indexes',
    ]);

    const spineResult = await applyMigrations({
      db: spine.db,
      migrationsFolder: FRAMEWORK_SPINE_MIGRATIONS,
    });
    expect(spineResult.applied).toBe(3);
    expect(spineResult.tags).toEqual([
      '0000_opaque_dispatch',
      '0001_request_idempotency',
      '0002_claim_and_retention_indexes',
    ]);

    const tenantTables = await tenant.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'core_plumbus'
      ORDER BY table_name
    `);
    const tenantNames = (tenantTables as unknown as Array<{ table_name: string }>).map(
      (row) => row.table_name,
    );
    expect(tenantNames).toEqual(
      expect.arrayContaining([
        'dispatch_outbox',
        'execution_state',
        'side_effect_log',
        'step_execution',
        'terminal_state',
        'wait_state',
        'human_task',
        'approval_request',
        'approval_decision',
        'request_idempotency',
      ]),
    );

    const spineTables = await spine.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('opaque_dispatch', 'request_idempotency')
    `);
    expect((spineTables as unknown as unknown[]).length).toBe(2);

    const again = await applyMigrations({
      db: tenant.db,
      migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
    });
    expect(again.applied).toBe(0);

    // The claim and retention indexes, with the exact partial predicates the queries match.
    const indexDefinitions = async (db: typeof tenant.db, table: string) =>
      Object.fromEntries(
        (
          (await db.execute(
            sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ${table}`,
          )) as unknown as Array<{ indexname: string; indexdef: string }>
        ).map((row) => [row.indexname, row.indexdef]),
      );
    const outbox = await indexDefinitions(tenant.db, 'dispatch_outbox');
    expect(outbox.dispatch_outbox_unpublished_idx).toContain(
      'WHERE ((published_at IS NULL) AND (spine_acked_at IS NULL) AND (superseded = false))',
    );
    expect(outbox.dispatch_outbox_spine_row_idx).toContain('WHERE (spine_acked_at IS NULL)');
    expect(outbox.dispatch_outbox_acked_idx).toContain('WHERE (spine_acked_at IS NOT NULL)');
    expect(await indexDefinitions(tenant.db, 'execution_state')).toHaveProperty(
      'execution_state_terminal_idx',
    );
    expect(await indexDefinitions(tenant.db, 'side_effect_log')).toHaveProperty(
      'side_effect_log_applied_idx',
    );
    const hints = await indexDefinitions(spine.db, 'opaque_dispatch');
    expect(hints.opaque_dispatch_runnable_idx).toContain('USING btree (created_at)');
    expect(hints.opaque_dispatch_execution_idx).toContain('(execution_id, created_at)');
    expect(hints.opaque_dispatch_acked_idx).toContain("'acknowledged'::text");
  });
});
