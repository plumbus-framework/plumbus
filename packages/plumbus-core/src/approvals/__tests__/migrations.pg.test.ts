import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { applyMigrations } from '../../data/migration.js';
import { PLAN02_DB_NAME_PATTERN } from '../../durable/apply-ddl.js';
import { createPlan02Database } from '../../durable/harness.js';
import { FRAMEWORK_DURABLE_TENANT_MIGRATIONS } from '../../durable/migrations-path.js';

describe('Stage 4 shipped human-task SQL', () => {
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const close of closers.reverse()) {
      await close();
    }
  });

  it('applies 0001 on a dedicated plumbus_plan02_* DB and never names tenant_qv', async () => {
    const tenant = await createPlan02Database({ kind: 'htask', ddl: '' });
    closers.push(tenant.close);

    expect(tenant.name).toMatch(PLAN02_DB_NAME_PATTERN);
    expect(tenant.name).not.toMatch(/tenant_qv/);

    const first = await applyMigrations({
      db: tenant.db,
      migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
    });
    expect(first.tags).toEqual(['0000_plan02_durable_tenant', '0001_plan02_human_task']);

    const tables = await tenant.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'core_plumbus'
        AND table_name IN ('human_task', 'approval_request', 'approval_decision')
      ORDER BY table_name
    `);
    const names = (tables as unknown as Array<{ table_name: string }>).map((row) => row.table_name);
    expect(names).toEqual(['approval_decision', 'approval_request', 'human_task']);

    const again = await applyMigrations({
      db: tenant.db,
      migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
    });
    expect(again.applied).toBe(0);
  });
});
