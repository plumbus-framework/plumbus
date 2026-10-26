// Framework retention against real Postgres: what `pruneFrameworkTables` and
// `pruneSpineDispatchHints` delete, what they must keep, their batch bounds, the worker pool
// running them on the pool, the spine and a tenant plane, and the claim queries' use of the
// partial indexes under a generic (parameter-free) plan.

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  claimSpineDispatch,
  claimUnpublishedOutbox,
  createDurableTestHarness,
  type DurableTestHarness,
  flowExecutionsDdl,
} from '../../durable/index.js';
import { ConsumerRegistry, createInMemoryQueue } from '../../events/index.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import type { PlumbusConfig } from '../../types/config.js';
import { createWorkerPool } from '../../worker/index.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import {
  pruneFrameworkTables,
  pruneSpineDispatchHints,
  resolveFrameworkRetentionOptions,
} from '../retention.js';

const SCHEDULE_DDL = `
CREATE TABLE flow_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_name text NOT NULL UNIQUE,
  cron text NOT NULL,
  next_run_at timestamptz,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE flow_schedule_ticks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL,
  scheduled_for timestamptz NOT NULL,
  revision integer NOT NULL,
  execution_id uuid,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX flow_schedule_tick_unique ON flow_schedule_ticks (schedule_id, scheduled_for);
CREATE INDEX flow_schedule_ticks_created_idx ON flow_schedule_ticks (created_at);
`;

const OLD = sql.raw(`now() - interval '40 days'`);
const RECENT = sql.raw(`now() - interval '1 day'`);

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
    await applyDdl(harness.tenantDb, SCHEDULE_DDL);
    await body(harness);
  } finally {
    await harness.close();
  }
}

async function flowRow(
  db: PostgresJsDatabase,
  status: string,
  at: ReturnType<typeof sql.raw>,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO flow_executions (flow_name, domain, status, input, actor, tenant_id, created_at, updated_at)
    VALUES ('probe', 'testing', ${status}, '{}'::jsonb, 'tester', 'tenant-a', ${at}, ${at})
    RETURNING id::text
  `);
  return String([...rows][0]?.id);
}

async function durableState(
  db: PostgresJsDatabase,
  executionId: string,
  status: string,
  terminal: boolean,
  at: ReturnType<typeof sql.raw>,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO core_plumbus.execution_state (
      execution_id, state_ref_id, tenant_ref, revision, tenant_epoch, status, definition_id,
      definition_version, current_step_id, step_index, attempt, correlation_id, created_at,
      updated_at, terminal
    ) VALUES (
      ${executionId}, ${`state:${executionId}`}, 'tenant-a', 2, 1, ${status}, 'probe', '1',
      'only', 1, 0, 'corr', ${at}, ${at}, ${terminal}
    )
  `);
  await db.execute(sql`
    INSERT INTO core_plumbus.wait_state (wait_state_id, execution_id, step_id, kind, state, created_at, updated_at)
    VALUES (${`wait:${executionId}:1`}, ${executionId}, 'only', 'retry', 'resolved', ${at}, ${at})
  `);
  await db.execute(sql`
    INSERT INTO core_plumbus.step_execution (step_execution_id, execution_id, step_id, attempt, state, started_at, updated_at)
    VALUES (${`step:${executionId}`}, ${executionId}, 'only', 0, 'done', ${at}, ${at})
  `);
  await db.execute(sql`
    INSERT INTO core_plumbus.terminal_state (terminal_state_id, execution_id, operational_state, final_revision, completed_at)
    VALUES (${`terminal:${executionId}`}, ${executionId}, ${status}, 2, ${at})
  `);
  await outboxRow(db, executionId, 1, { acked: true, at });
}

async function outboxRow(
  db: PostgresJsDatabase,
  executionId: string,
  revision: number,
  options: { acked: boolean; at: ReturnType<typeof sql.raw> },
): Promise<string> {
  const outboxId = `outbox:${executionId}:${revision}`;
  await db.execute(sql`
    INSERT INTO core_plumbus.dispatch_outbox (
      outbox_id, execution_id, state_ref_id, expected_revision, tenant_epoch, tenant_ref, step_id,
      definition_id, definition_version, correlation_id, work_class_id, priority_class_id,
      not_before, created_at, published_at, spine_row_id, spine_acked_at, superseded
    ) VALUES (
      ${outboxId}, ${executionId}, ${`state:${executionId}`}, ${revision}, 1, 'tenant-a', 'only',
      'probe', '1', 'corr', 'default', 'default', ${options.at}, ${options.at},
      ${options.at}, ${`disp:${executionId}:${revision}`},
      ${options.acked ? options.at : null}, false
    )
  `);
  return outboxId;
}

async function hint(
  db: PostgresJsDatabase,
  executionId: string,
  revision: number,
  state: string,
  at: ReturnType<typeof sql.raw>,
): Promise<string> {
  const dispatchId = `disp:${executionId}:${revision}`;
  await db.execute(sql`
    INSERT INTO opaque_dispatch (
      dispatch_id, contract_version, tenant_route_id, execution_id, definition_id,
      definition_version, step_id, tenant_execution_state_ref_id, expected_revision, tenant_epoch,
      work_class_id, priority_class_id, delivery_state, attempt, not_before, correlation_id,
      created_at, updated_at
    ) VALUES (
      ${dispatchId}, '1', 'tenant-a', ${executionId}, 'probe', '1', 'only',
      ${`state:${executionId}`}, ${revision}, 1, 'default', 'default', ${state}, 1, ${at}, 'corr',
      ${at}, ${at}
    )
  `);
  return dispatchId;
}

async function ids(db: PostgresJsDatabase, query: ReturnType<typeof sql>): Promise<string[]> {
  return [...(await db.execute<{ id: string }>(query))].map((row) => String(row.id)).sort();
}

describe('framework retention', () => {
  it('validates its options and stays off unless asked', () => {
    expect(resolveFrameworkRetentionOptions(undefined)).toBeUndefined();
    expect(resolveFrameworkRetentionOptions(false)).toBeUndefined();
    expect(resolveFrameworkRetentionOptions(true)).toEqual({
      keepDays: 30,
      batchSize: 500,
      maxBatchesPerTable: 20,
      intervalMs: 3_600_000,
    });
    expect(resolveFrameworkRetentionOptions({ keepDays: 7 })?.keepDays).toBe(7);
    expect(() => resolveFrameworkRetentionOptions({ keepDays: 0 })).toThrow(/keepDays/);
    expect(() => resolveFrameworkRetentionOptions({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() =>
      resolveFrameworkRetentionOptions({ keepdays: 3 } as unknown as { keepDays: number }),
    ).toThrow(/frameworkRetention/);
  });

  it('deletes finished rows past the window and keeps everything still claimable, replayable or deduped against', async () => {
    await withHarness(async ({ tenantDb, spineDb }) => {
      // Flow executions.
      const oldCompleted = await flowRow(tenantDb, 'completed', OLD);
      const oldCancelled = await flowRow(tenantDb, 'cancelled', OLD);
      const oldFailed = await flowRow(tenantDb, 'failed', OLD);
      const oldWaiting = await flowRow(tenantDb, 'waiting', OLD);
      const recentCompleted = await flowRow(tenantDb, 'completed', RECENT);
      const withIntent = await flowRow(tenantDb, 'completed', OLD);
      await tenantDb.execute(sql`
        INSERT INTO flow_start_intents (execution_id, flow_name, input, auth_snapshot_json, next_attempt_at)
        VALUES (${withIntent}::uuid, 'probe', '{}'::jsonb, '{}'::jsonb, now())
      `);
      const durableOpen = await flowRow(tenantDb, 'completed', OLD);
      await durableState(tenantDb, durableOpen, 'running', false, OLD);

      // Tenant durable state.
      await durableState(tenantDb, oldCompleted, 'succeeded', true, OLD);
      await durableState(tenantDb, oldFailed, 'failed', true, OLD);
      await durableState(tenantDb, recentCompleted, 'succeeded', true, RECENT);
      const liveAcked = await outboxRow(tenantDb, oldWaiting, 1, { acked: true, at: OLD });
      const liveUnacked = await outboxRow(tenantDb, oldWaiting, 2, { acked: false, at: OLD });
      await tenantDb.execute(sql`
        INSERT INTO core_plumbus.side_effect_log (effect_key, label, applied_at) VALUES
          ('old-effect', 'old', ${OLD}), ('recent-effect', 'recent', ${RECENT})
      `);

      // Schedule ticks: one behind its schedule, one at its schedule's next slot, one recent.
      const schedule = String(
        [
          ...(await tenantDb.execute<{ id: string }>(sql`
            INSERT INTO flow_schedules (flow_name, cron, next_run_at)
            VALUES ('probe', '* * * * *', now() - interval '35 days') RETURNING id::text
          `)),
        ][0]?.id,
      );
      await tenantDb.execute(sql`
        INSERT INTO flow_schedule_ticks (schedule_id, scheduled_for, revision, outcome, created_at) VALUES
          (${schedule}::uuid, now() - interval '40 days', 1, 'started', ${OLD}),
          (${schedule}::uuid, now() - interval '35 days', 1, 'started', ${OLD}),
          (${schedule}::uuid, now() - interval '1 day', 1, 'started', ${RECENT})
      `);

      // Spine hints: the pruned execution's acknowledged hint, a live execution's superseded and
      // newest hints, a dead-lettered one.
      const prunedHint = await hint(spineDb, oldCompleted, 1, 'acknowledged', OLD);
      const supersededHint = await hint(spineDb, oldWaiting, 1, 'acknowledged', OLD);
      const newestHint = await hint(spineDb, oldWaiting, 2, 'acknowledged', OLD);
      const deadHint = await hint(spineDb, oldFailed, 1, 'dead-lettered', OLD);

      const result = await pruneFrameworkTables(tenantDb, { keepDays: 30, spineDb });
      expect(result).toEqual({
        flowExecutions: 2,
        durableExecutions: 1,
        // Every acknowledged row past the window: the live execution's and those of the
        // executions kept for other reasons (their hints are done with either way).
        dispatchOutbox: 3,
        sideEffects: 1,
        scheduleTicks: 1,
        spineHints: 1,
        drained: true,
      });
      const remainingFlows = await ids(tenantDb, sql`SELECT id::text AS id FROM flow_executions`);
      expect(remainingFlows).not.toContain(oldCancelled);
      expect(remainingFlows).not.toContain(oldCompleted);
      expect(remainingFlows).toEqual(
        [oldFailed, oldWaiting, recentCompleted, withIntent, durableOpen].sort(),
      );
      expect(
        await ids(tenantDb, sql`SELECT execution_id AS id FROM core_plumbus.execution_state`),
      ).toEqual([durableOpen, oldFailed, recentCompleted].sort());
      for (const table of ['wait_state', 'step_execution', 'terminal_state']) {
        expect(
          await ids(
            tenantDb,
            sql`SELECT execution_id AS id FROM ${sql.raw(`core_plumbus.${table}`)}`,
          ),
        ).toEqual([durableOpen, oldFailed, recentCompleted].sort());
      }
      expect(
        await ids(tenantDb, sql`SELECT outbox_id AS id FROM core_plumbus.dispatch_outbox`),
      ).toEqual([liveUnacked, `outbox:${recentCompleted}:1`].sort());
      expect(liveAcked).not.toBe(liveUnacked);
      expect(
        await ids(tenantDb, sql`SELECT effect_key AS id FROM core_plumbus.side_effect_log`),
      ).toEqual(['recent-effect']);
      expect(
        Number(
          [
            ...(await tenantDb.execute<{ n: number }>(
              sql`SELECT count(*)::int AS n FROM flow_schedule_ticks`,
            )),
          ][0]?.n,
        ),
      ).toBe(2);
      expect(await ids(spineDb, sql`SELECT dispatch_id AS id FROM opaque_dispatch`)).toEqual(
        [supersededHint, newestHint, deadHint].sort(),
      );
      expect(prunedHint).toBeDefined();

      // The spine pass: the superseded acknowledged hint goes, the newest and the dead letter stay.
      expect(await pruneSpineDispatchHints(spineDb, { keepDays: 30 })).toEqual({
        spineHints: 1,
        drained: true,
      });
      expect(await ids(spineDb, sql`SELECT dispatch_id AS id FROM opaque_dispatch`)).toEqual(
        [newestHint, deadHint].sort(),
      );

      // A second pass finds nothing.
      expect(await pruneFrameworkTables(tenantDb, { keepDays: 30, spineDb })).toMatchObject({
        flowExecutions: 0,
        durableExecutions: 0,
        dispatchOutbox: 0,
        sideEffects: 0,
        scheduleTicks: 0,
        spineHints: 0,
        drained: true,
      });
    });
  });

  it('deletes in bounded batches and reports a backlog', async () => {
    await withHarness(async ({ tenantDb }) => {
      for (let index = 0; index < 5; index += 1) await flowRow(tenantDb, 'completed', OLD);
      const first = await pruneFrameworkTables(tenantDb, {
        keepDays: 30,
        batchSize: 2,
        maxBatchesPerTable: 2,
      });
      expect(first.flowExecutions).toBe(4);
      expect(first.drained).toBe(false);
      const second = await pruneFrameworkTables(tenantDb, {
        keepDays: 30,
        batchSize: 2,
        maxBatchesPerTable: 2,
      });
      expect(second.flowExecutions).toBe(1);
      expect(second.drained).toBe(true);
    });
  });

  it('skips the tables a database does not have', async () => {
    await withHarness(async ({ spineDb }) => {
      // The spine has no flow, durable or schedule tables here.
      expect(await pruneFrameworkTables(spineDb, { keepDays: 30 })).toMatchObject({
        flowExecutions: 0,
        durableExecutions: 0,
        drained: true,
      });
    });
  });

  it('runs from the worker pool on the pool database, the spine and every listed tenant plane', async () => {
    await withHarness(async (harness) => {
      await applyDdl(harness.spineDb, flowExecutionsDdl());
      const tenantRow = await flowRow(harness.tenantDb, 'completed', OLD);
      await durableState(harness.tenantDb, tenantRow, 'succeeded', true, OLD);
      const tenantHint = await hint(harness.spineDb, tenantRow, 1, 'acknowledged', OLD);
      const poolRow = await flowRow(harness.spineDb, 'cancelled', OLD);
      const keptPoolRow = await flowRow(harness.spineDb, 'failed', OLD);

      const pool = createWorkerPool({
        config: { environment: 'test', database: harness.admin } as PlumbusConfig,
        db: harness.spineDb,
        flows: new FlowRegistry(),
        consumers: new ConsumerRegistry(),
        queue: createInMemoryQueue(),
        audit: { record: async () => {} },
        dataPlaneResolver: createSingleDataPlaneResolver(harness.tenantDb, {
          coreSchema: harness.coreSchema,
        }),
        listTenantRefs: () => ['tenant-a'],
        frameworkSchema: harness.coreSchema,
        enableScheduler: false,
        enableDispatcher: false,
        enableEventWorker: false,
        flowPollIntervalMs: 1000,
        frameworkRetention: { keepDays: 30, intervalMs: 50 },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        stepDeps: {
          async executeCapability() {
            return { success: true, data: {} };
          },
          evaluateCondition: () => true,
        },
      });
      await pool.start();
      try {
        await expect
          .poll(
            async () => ({
              tenant: await ids(harness.tenantDb, sql`SELECT id::text AS id FROM flow_executions`),
              pool: await ids(harness.spineDb, sql`SELECT id::text AS id FROM flow_executions`),
              hints: await ids(harness.spineDb, sql`SELECT dispatch_id AS id FROM opaque_dispatch`),
            }),
            { timeout: 10_000, interval: 50 },
          )
          .toEqual({ tenant: [], pool: [keptPoolRow], hints: [] });
      } finally {
        await pool.stop();
      }
      expect(poolRow).not.toBe(keptPoolRow);
      expect(tenantHint).toBeDefined();
    });
  }, 30_000);

  it('rejects invalid retention options when the pool is built', async () => {
    await withHarness(async (harness) => {
      expect(() =>
        createWorkerPool({
          config: { environment: 'test', database: harness.admin } as PlumbusConfig,
          db: harness.spineDb,
          flows: new FlowRegistry(),
          consumers: new ConsumerRegistry(),
          queue: createInMemoryQueue(),
          frameworkRetention: { keepDays: -1 },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          stepDeps: {
            async executeCapability() {
              return { success: true, data: {} };
            },
            evaluateCondition: () => true,
          },
        }),
      ).toThrow(/keepDays/);
    });
  });
});

describe('claim queries use their partial indexes under a generic plan', () => {
  /** A second connection to the same database whose queries are recorded. */
  function recordingDb(harness: DurableTestHarness, database: string) {
    const client = postgres({
      host: harness.admin.host,
      port: harness.admin.port,
      database,
      username: harness.admin.user,
      password: harness.admin.password,
      max: 1,
      onnotice: () => {},
    });
    const queries: string[] = [];
    const db = drizzle(client, {
      logger: {
        logQuery(query) {
          queries.push(query);
        },
      },
    });
    return { db, client, queries };
  }

  async function genericPlan(client: postgres.Sql, query: string): Promise<string> {
    const rows = await client.unsafe(`EXPLAIN (GENERIC_PLAN) ${query}`);
    return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
  }

  it('flow_executions, dispatch_outbox and opaque_dispatch', async () => {
    await withHarness(async (harness) => {
      // Mostly finished rows, a few runnable ones, fresh statistics.
      await harness.tenantDb.execute(sql`
        INSERT INTO flow_executions (flow_name, domain, status, input, actor, created_at, updated_at)
        SELECT 'probe', 'testing', 'completed', '{}'::jsonb, 'tester', now(), now()
        FROM generate_series(1, 5000)
      `);
      await flowRow(harness.tenantDb, 'created', RECENT);
      await harness.tenantDb.execute(sql`
        INSERT INTO core_plumbus.dispatch_outbox (
          outbox_id, execution_id, state_ref_id, expected_revision, tenant_epoch, tenant_ref,
          step_id, definition_id, definition_version, correlation_id, work_class_id,
          priority_class_id, not_before, created_at, published_at, spine_acked_at, superseded
        )
        SELECT 'o' || g, 'e' || g, 's', 1, 1, 't', 'only', 'probe', '1', 'c', 'w', 'p',
               now(), now(), now(), now(), false
        FROM generate_series(1, 5000) g
      `);
      await harness.spineDb.execute(sql`
        INSERT INTO opaque_dispatch (
          dispatch_id, contract_version, tenant_route_id, execution_id, definition_id,
          definition_version, step_id, tenant_execution_state_ref_id, expected_revision,
          tenant_epoch, work_class_id, priority_class_id, delivery_state, attempt, not_before,
          correlation_id, created_at, updated_at
        )
        SELECT 'd' || g, '1', 't', 'e' || g, 'probe', '1', 'only', 's', 1, 1, 'w', 'p',
               'acknowledged', 1, now(), 'c', now(), now()
        FROM generate_series(1, 5000) g
      `);
      await harness.tenantDb.execute(sql`ANALYZE`);
      await harness.spineDb.execute(sql`ANALYZE`);

      const tenant = recordingDb(harness, harness.tenantName);
      const spine = recordingDb(harness, harness.spineName);
      try {
        const engine = createFlowEngine({
          db: tenant.db,
          registry: new FlowRegistry(),
          stepDeps: {
            async executeCapability() {
              return { success: true, data: {} };
            },
            evaluateCondition: () => true,
          },
        });
        await engine.claimNext(1);
        const flowClaim = tenant.queries.find((query) => query.includes('FOR UPDATE SKIP LOCKED'));
        expect(flowClaim).toBeDefined();
        expect(await genericPlan(tenant.client, flowClaim ?? '')).toContain(
          'flow_exec_runnable_idx',
        );

        tenant.queries.length = 0;
        await claimUnpublishedOutbox(tenant.db, async () => {}, {
          schemaName: harness.coreSchema,
        });
        const outboxClaim = tenant.queries.find((query) => query.includes('SKIP LOCKED'));
        expect(await genericPlan(tenant.client, outboxClaim ?? '')).toContain(
          'dispatch_outbox_unpublished_idx',
        );

        await claimSpineDispatch(spine.db, { workerId: 'w', leaseDurationMs: 1000 });
        const hintClaim = spine.queries.find((query) => query.includes('SKIP LOCKED'));
        expect(await genericPlan(spine.client, hintClaim ?? '')).toContain(
          'opaque_dispatch_runnable_idx',
        );
      } finally {
        await tenant.client.end({ timeout: 5 });
        await spine.client.end({ timeout: 5 });
      }
    });
  });
});
