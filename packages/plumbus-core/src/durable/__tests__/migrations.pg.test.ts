import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { applyMigrations } from '../../data/migration.js';
import { PLAN02_DB_NAME_PATTERN } from '../apply-ddl.js';
import { createPlan02Database } from '../harness.js';
import {
  FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
  FRAMEWORK_SPINE_MIGRATIONS,
} from '../migrations-path.js';

describe('Plan 02 shipped SQL migrations', () => {
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const close of closers.reverse()) {
      await close();
    }
  });

  it('applies tenant durable and spine journals on dedicated plumbus_plan02_* DBs', async () => {
    const tenant = await createPlan02Database({ kind: 'migten', ddl: '' });
    closers.push(tenant.close);
    const spine = await createPlan02Database({ kind: 'migspine', ddl: '' });
    closers.push(spine.close);

    expect(tenant.name).toMatch(PLAN02_DB_NAME_PATTERN);
    expect(spine.name).toMatch(PLAN02_DB_NAME_PATTERN);
    expect(tenant.name).not.toMatch(/tenant_qv/);
    expect(spine.name).not.toMatch(/tenant_qv/);

    const tenantResult = await applyMigrations({
      db: tenant.db,
      migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
    });
    expect(tenantResult.applied).toBe(2);
    expect(tenantResult.tags).toEqual(['0000_plan02_durable_tenant', '0001_plan02_human_task']);

    const spineResult = await applyMigrations({
      db: spine.db,
      migrationsFolder: FRAMEWORK_SPINE_MIGRATIONS,
    });
    expect(spineResult.applied).toBe(1);
    expect(spineResult.tags).toEqual(['0000_plan02_opaque_dispatch']);

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
      ]),
    );

    const spineTables = await spine.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'opaque_dispatch'
    `);
    expect((spineTables as unknown as unknown[]).length).toBe(1);

    const again = await applyMigrations({
      db: tenant.db,
      migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
    });
    expect(again.applied).toBe(0);
  });
});
