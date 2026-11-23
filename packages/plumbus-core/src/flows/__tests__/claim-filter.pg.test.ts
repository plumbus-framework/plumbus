// The flow engine's claim filter (worker flow lanes) against real Postgres: which executions a
// claim leaves for later by tenant, by flow and by tenancy, in both claim paths (the engine's
// own `flow_executions`, and spine hints with control-plane rows beside them), and that the
// filtered claims keep the partial indexes their unfiltered form uses.

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import {
  claimSpineDispatch,
  createDurableTestHarness,
  type DurableTestHarness,
  flowExecutionsDdl,
} from '../../durable/index.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import { FlowStepType } from '../../types/enums.js';
import type { AuthContext } from '../../types/security.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';

async function applyDdl(db: PostgresJsDatabase, ddl: string): Promise<void> {
  for (const statement of ddl
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean))
    await db.execute(sql.raw(statement));
}

async function withHarness(body: (harness: DurableTestHarness) => Promise<void>): Promise<void> {
  const harness = await createDurableTestHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

function registry(): FlowRegistry {
  const flows = new FlowRegistry();
  for (const name of ['heavy', 'light']) {
    flows.register(
      defineFlow({
        name,
        domain: 'lanes',
        input: z.object({}),
        steps: [{ name: 'only', type: FlowStepType.Capability, capability: 'lanes.noop' }],
      }),
    );
  }
  return flows;
}

const stepDeps = {
  async executeCapability() {
    return { success: true as const, data: {} };
  },
  evaluateCondition: () => true,
};

function auth(tenantId?: string): AuthContext {
  return {
    userId: 'tester',
    roles: ['system'],
    scopes: [],
    provider: 'test',
    ...(tenantId ? { tenantId } : {}),
  };
}

/** Insert a runnable row `seconds` ago on the engine's own table; returns its id. */
async function ownRow(
  db: PostgresJsDatabase,
  flowName: string,
  tenantId: string | null,
  secondsAgo: number,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO flow_executions (flow_name, domain, status, input, actor, tenant_id, created_at, updated_at)
    VALUES (${flowName}, 'lanes', 'created', '{}'::jsonb, 'tester', ${tenantId},
            now() - make_interval(secs => ${secondsAgo}), now())
    RETURNING id::text
  `);
  return String([...rows][0]?.id);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('flow claim filter on the engine table', () => {
  it('leaves tenants, flows and a tenancy for later, oldest eligible first', async () => {
    await withHarness(async ({ tenantDb }) => {
      const a1 = await ownRow(tenantDb, 'heavy', 'college-a', 50);
      const a2 = await ownRow(tenantDb, 'light', 'college-a', 40);
      const u1 = await ownRow(tenantDb, 'heavy', null, 30);
      const b1 = await ownRow(tenantDb, 'heavy', 'college-b', 20);
      const u2 = await ownRow(tenantDb, 'light', null, 10);
      const engine = createFlowEngine({ db: tenantDb, registry: registry(), stepDeps });
      const claim = async (filter: Parameters<typeof engine.claimNext>[1]) =>
        (await engine.claimNext(1, filter)).map((row) => row.id);

      expect(await claim({ excludeFlows: ['heavy'] })).toEqual([a2]);
      // A row with no tenant is never held back by a tenant exclusion.
      expect(await claim({ excludeTenants: ['college-a'] })).toEqual([u1]);
      expect(await claim({ excludeTenants: ['college-a'], tenancy: 'tenanted' })).toEqual([b1]);
      // Untenanted first: the newest untenanted row before the older tenant row.
      expect(await claim({ untenantedFirst: true })).toEqual([u2]);
      expect(await claim({ tenancy: 'untenanted' })).toEqual([]);
      expect(await claim({ excludeExecutions: [a1] })).toEqual([]);
      // Without a filter the claim is as before: the oldest runnable row.
      expect(await claim(undefined)).toEqual([a1]);
    });
  });

  it('keeps claiming after it released an execution for a missing definition', async () => {
    // Regression: the skip list of released executions went to Postgres as a `($1)` tuple cast
    // to text[] — `malformed array literal` — so every claim failed for the next 60 s.
    await withHarness(async ({ tenantDb }) => {
      const ghost = await ownRow(tenantDb, 'ghost', null, 20);
      const engine = createFlowEngine({ db: tenantDb, registry: registry(), stepDeps });
      expect((await engine.claimNext(1)).map((row) => row.id)).toEqual([ghost]);
      await expect(
        engine.runNext(ghost, { auth: auth(), logger: console } as never),
      ).rejects.toMatchObject({ name: 'FlowDefinitionUnavailableError' });
      const next = await ownRow(tenantDb, 'light', null, 10);
      expect((await engine.claimNext(1)).map((row) => row.id)).toEqual([next]);
    });
  });

  it('keeps flow_exec_runnable_idx under a generic plan with every exclusion', async () => {
    await withHarness(async (harness) => {
      await harness.tenantDb.execute(sql`
        INSERT INTO flow_executions (flow_name, domain, status, input, actor, tenant_id, created_at, updated_at)
        SELECT 'heavy', 'lanes', 'completed', '{}'::jsonb, 'tester', 'college-' || (g % 50), now(), now()
        FROM generate_series(1, 5000) g
      `);
      await ownRow(harness.tenantDb, 'light', 'college-a', 1);
      await harness.tenantDb.execute(sql`ANALYZE`);
      const client = postgres({
        host: harness.admin.host,
        port: harness.admin.port,
        database: harness.tenantName,
        username: harness.admin.user,
        password: harness.admin.password,
        max: 1,
        onnotice: () => {},
      });
      const queries: string[] = [];
      const db = drizzle(client, { logger: { logQuery: (query) => queries.push(query) } });
      try {
        const engine = createFlowEngine({ db, registry: registry(), stepDeps });
        await engine.claimNext(1, {
          excludeFlows: ['heavy'],
          excludeTenants: ['college-b'],
          tenancy: 'tenanted',
          excludeExecutions: ['00000000-0000-0000-0000-000000000001'],
        });
        const claim = queries.find((query) => query.includes('FOR UPDATE SKIP LOCKED'));
        expect(claim).toContain('flow_name = ANY');
        const plan = await client.unsafe(`EXPLAIN (GENERIC_PLAN) ${claim ?? ''}`);
        expect(plan.map((row) => String(row['QUERY PLAN'])).join('\n')).toContain(
          'flow_exec_runnable_idx',
        );
      } finally {
        await client.end({ timeout: 5 });
      }
    });
  });
});

describe('flow claim filter on spine hints', () => {
  it('leaves hints by tenant route and definition, and control-plane rows by tenancy', async () => {
    await withHarness(async (harness) => {
      await applyDdl(harness.spineDb, flowExecutionsDdl());
      const engine = createFlowEngine({
        db: harness.spineDb,
        registry: registry(),
        stepDeps,
        spineDispatch: {
          db: harness.spineDb,
          resolver: createSingleDataPlaneResolver(harness.tenantDb, {
            coreSchema: harness.coreSchema,
          }),
          coreSchema: harness.coreSchema,
          untenanted: 'control-plane',
        },
        flowLeaseDurationMs: 60_000,
      });
      const started: Record<string, string> = {};
      for (const [key, flowName, tenant] of [
        ['aHeavy', 'heavy', 'college-a'],
        ['aLight', 'light', 'college-a'],
        ['bHeavy', 'heavy', 'college-b'],
        ['sweep', 'light', undefined],
        ['bLight', 'light', 'college-b'],
      ] as const) {
        started[key] = (await engine.start(flowName, {}, auth(tenant))).id;
        await pause();
      }
      const claim = async (filter: Parameters<typeof engine.claimNext>[1]) =>
        (await engine.claimNext(1, filter)).map((row) => row.id);

      expect(await claim({ excludeTenants: ['college-a'] })).toEqual([started.bHeavy]);
      expect(await claim({ excludeFlows: ['heavy'] })).toEqual([started.aLight]);
      // Only untenanted: the hints stay, the control-plane row is taken.
      expect(await claim({ tenancy: 'untenanted' })).toEqual([started.sweep]);
      expect(await claim({ tenancy: 'untenanted' })).toEqual([]);
      expect(await claim({ excludeTenants: ['college-a', 'college-b'] })).toEqual([]);
      expect(await claim(undefined)).toEqual([started.aHeavy]);
      // The leased hints are the claimed executions'; the rest are still ready.
      const states = await harness.spineDb.execute<{
        execution_id: string;
        delivery_state: string;
      }>(sql`SELECT execution_id, delivery_state FROM opaque_dispatch ORDER BY created_at`);
      expect(
        Object.fromEntries([...states].map((row) => [row.execution_id, row.delivery_state])),
      ).toEqual({
        [String(started.aHeavy)]: 'leased',
        [String(started.aLight)]: 'leased',
        [String(started.bHeavy)]: 'leased',
        [String(started.bLight)]: 'ready',
      });
    });
  });

  it('prefers the control-plane row when asked, then the hints', async () => {
    await withHarness(async (harness) => {
      await applyDdl(harness.spineDb, flowExecutionsDdl());
      const engine = createFlowEngine({
        db: harness.spineDb,
        registry: registry(),
        stepDeps,
        spineDispatch: {
          db: harness.spineDb,
          resolver: createSingleDataPlaneResolver(harness.tenantDb, {
            coreSchema: harness.coreSchema,
          }),
          coreSchema: harness.coreSchema,
          untenanted: 'control-plane',
        },
      });
      const tenantRow = (await engine.start('heavy', {}, auth('college-a'))).id;
      await pause();
      const sweep = (await engine.start('light', {}, auth())).id;
      // Before: hints first, whatever their age.
      const unfiltered = createFlowEngine({
        db: harness.spineDb,
        registry: registry(),
        stepDeps,
        spineDispatch: {
          db: harness.spineDb,
          resolver: createSingleDataPlaneResolver(harness.tenantDb, {
            coreSchema: harness.coreSchema,
          }),
          coreSchema: harness.coreSchema,
          untenanted: 'control-plane',
        },
      });
      expect((await engine.claimNext(1, { untenantedFirst: true })).map((row) => row.id)).toEqual([
        sweep,
      ]);
      expect((await unfiltered.claimNext(1)).map((row) => row.id)).toEqual([tenantRow]);
    });
  });

  it('keeps opaque_dispatch_runnable_idx under a generic plan with tenant and flow exclusions', async () => {
    await withHarness(async (harness) => {
      await harness.spineDb.execute(sql`
        INSERT INTO opaque_dispatch (
          dispatch_id, contract_version, tenant_route_id, execution_id, definition_id,
          definition_version, step_id, tenant_execution_state_ref_id, expected_revision,
          tenant_epoch, work_class_id, priority_class_id, delivery_state, attempt, not_before,
          correlation_id, created_at, updated_at
        )
        SELECT 'd' || g, '1', 'college-' || (g % 50), 'e' || g, 'heavy', '1', 'only', 's', 1, 1,
               'w', 'p', 'acknowledged', 1, now(), 'c', now(), now()
        FROM generate_series(1, 5000) g
      `);
      await harness.spineDb.execute(sql`ANALYZE`);
      const client = postgres({
        host: harness.admin.host,
        port: harness.admin.port,
        database: harness.spineName,
        username: harness.admin.user,
        password: harness.admin.password,
        max: 1,
        onnotice: () => {},
      });
      const queries: string[] = [];
      const db = drizzle(client, { logger: { logQuery: (query) => queries.push(query) } });
      try {
        await claimSpineDispatch(db, {
          workerId: 'w',
          leaseDurationMs: 1000,
          excludeTenantRouteIds: ['college-1', 'college-2'],
          excludeDefinitionIds: ['heavy'],
        });
        const claim = queries.find((query) => query.includes('SKIP LOCKED'));
        expect(claim).toContain('tenant_route_id = ANY');
        expect(claim).toContain('definition_id = ANY');
        const plan = await client.unsafe(`EXPLAIN (GENERIC_PLAN) ${claim ?? ''}`);
        expect(plan.map((row) => String(row['QUERY PLAN'])).join('\n')).toContain(
          'opaque_dispatch_runnable_idx',
        );
      } finally {
        await client.end({ timeout: 5 });
      }
    });
  });
});
