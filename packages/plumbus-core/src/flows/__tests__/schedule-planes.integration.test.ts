import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import * as flows from '../schema.js';
import { defineFlow } from '../../define/defineFlow.js';
import { spineDispatchDdl, tenantDurableDdl } from '../../durable/apply-ddl.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { createFlowScheduler } from '../scheduler.js';

const bin = process.env.PLUMBUS_TEST_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
const CORE_SCHEMA = 'core_plumbus';
let root = '';
let data = '';
const clients: ReturnType<typeof postgres>[] = [];
function connect(database: string) {
  const client = postgres({
    host: root,
    username: 'plumbus',
    database,
    max: 3,
    onnotice: () => {},
  });
  clients.push(client);
  return { sql: client, db: drizzle(client) };
}
let pool: ReturnType<typeof connect>;
let tenantA: ReturnType<typeof connect>;
let tenantB: ReturnType<typeof connect>;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'plumbus-pg-planes-'));
  data = join(root, 'data');
  execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'plumbus', '-A', 'trust', '--no-locale'], {
    stdio: 'ignore',
  });
  execFileSync(
    join(bin, 'pg_ctl'),
    ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-F -h '' -k ${root}`, '-w', 'start'],
    { stdio: 'ignore' },
  );
  const admin = connect('postgres');
  await admin.sql.unsafe('CREATE DATABASE pool');
  await admin.sql.unsafe('CREATE DATABASE tenant_a');
  await admin.sql.unsafe('CREATE DATABASE tenant_b');
  pool = connect('pool');
  tenantA = connect('tenant_a');
  tenantB = connect('tenant_b'); // no tables: a broken plane
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(flows));
  for (const statement of statements) {
    await pool.sql.unsafe(statement);
    await tenantA.sql.unsafe(statement);
  }
  // Spine dispatch: hints on the pool (the spine), durable state on the tenant plane.
  const split = (ddl: string) =>
    ddl
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
  for (const statement of split(spineDispatchDdl())) await pool.sql.unsafe(statement);
  for (const statement of split(tenantDurableDdl(CORE_SCHEMA))) await tenantA.sql.unsafe(statement);
}, 60000);
afterAll(async () => {
  await Promise.all(clients.map((client) => client.end({ timeout: 1 })));
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], {
    stdio: 'ignore',
  });
  rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const plane of [pool, tenantA])
    await plane.sql.unsafe('TRUNCATE flow_executions, flow_schedules, flow_schedule_ticks');
  await pool.sql.unsafe('TRUNCATE opaque_dispatch');
  await tenantA.sql.unsafe(
    `TRUNCATE ${CORE_SCHEMA}.execution_state, ${CORE_SCHEMA}.dispatch_outbox CASCADE`,
  );
});
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** `spine`: the engine runs with spine dispatch over these planes (the worker's under a resolver). */
function setup(schedules: Record<string, any>, spine?: Record<string, any>) {
  const registry = new FlowRegistry();
  for (const [name, schedule] of Object.entries(schedules))
    registry.register(
      defineFlow({
        name,
        domain: 'test',
        input: z.object({}),
        schedule,
        steps: [{ name: 'one', type: 'capability' }],
      }),
    );
  const engine = createFlowEngine({
    db: pool.db,
    registry,
    workerId: 'A',
    logger,
    stepDeps: {
      executeCapability: async () => ({ success: true, data: {} }),
      evaluateCondition: () => true,
    },
    ...(spine
      ? {
          spineDispatch: {
            db: pool.db,
            resolver: resolver(spine),
            coreSchema: CORE_SCHEMA,
            untenanted: 'control-plane' as const,
          },
        }
      : {}),
  });
  return { registry, engine };
}
function resolver(refs: Record<string, any>) {
  return {
    resolve: async (tenantRef: string) => ({
      db: refs[tenantRef].db,
      coreSchema: 'core_plumbus',
      packageSchemaPrefix: 'pkg_',
      tenantRef,
    }),
  };
}

describe('schedule planes on real databases', () => {
  it('syncs, polls and reconciles per plane, tolerating a broken tenant plane', async () => {
    const { registry, engine } = setup({
      spineJob: { cron: 'every:1h', plane: 'spine' },
      tenantJob: { cron: 'every:1h' },
    });
    const scheduler = createFlowScheduler({
      db: pool.db,
      registry,
      engine,
      logger,
      resolver: resolver({ 'tenant-a': tenantA, 'tenant-b': tenantB }),
      listTenantRefs: () => ['tenant-a', 'tenant-b'],
    });
    expect(await scheduler.syncSchedules()).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler could not sync schedules on a plane',
      expect.objectContaining({ tenantRef: 'tenant-b' }),
    );
    expect((await pool.db.select().from(flows.flowSchedulesTable)).map((r) => r.flowName)).toEqual([
      'spineJob',
    ]);
    expect(
      (await tenantA.db.select().from(flows.flowSchedulesTable)).map((r) => r.flowName),
    ).toEqual(['tenantJob']);
    expect(await scheduler.poll()).toBe(2);
    // A plain engine (no spine dispatch) claims only from the pool, so by default the tenant
    // schedule's run and tick are created there too — the schedule row stays on its plane.
    expect(await tenantA.db.select().from(flows.flowExecutionsTable)).toHaveLength(0);
    expect(await tenantA.db.select().from(flows.flowScheduleTicksTable)).toHaveLength(0);
    const poolExecs = await pool.db
      .select()
      .from(flows.flowExecutionsTable)
      .orderBy(flows.flowExecutionsTable.flowName);
    expect(poolExecs).toMatchObject([
      { flowName: 'spineJob', tenantId: null },
      { flowName: 'tenantJob', tenantId: 'tenant-a' },
    ]);
    expect(await pool.db.select().from(flows.flowScheduleTicksTable)).toHaveLength(2);
    expect((await engine.claimNext(5)).map((row) => row.id).sort()).toEqual(
      poolExecs.map((row) => row.id).sort(),
    );
    expect(await scheduler.poll()).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler could not read schedules on a plane',
      expect.objectContaining({ tenantRef: 'tenant-b' }),
    );

    // Reconciliation must cover every plane: an unresolvable/broken plane fails it.
    await expect(scheduler.reconcileSchedules()).rejects.toThrow();
    const changed = setup({
      spineJob: { cron: 'every:2h', plane: 'spine' },
      tenantJob: { cron: 'every:3h' },
    });
    const next = createFlowScheduler({
      db: pool.db,
      ...changed,
      logger,
      resolver: resolver({ 'tenant-a': tenantA }),
      listTenantRefs: () => ['tenant-a'],
    });
    const preview = await next.reconcileSchedules();
    expect(preview.changes).toMatchObject([
      { flowName: 'spineJob', action: 'update', next: { cron: 'every:2h' } },
      {
        flowName: 'tenantJob',
        action: 'update',
        next: { cron: 'every:3h' },
        tenantRef: 'tenant-a',
      },
    ]);
    expect(preview.changes[0]).not.toHaveProperty('tenantRef');
    await expect(
      next.reconcileSchedules({ apply: true, expectedRevision: 'stale' }),
    ).rejects.toThrow('revision');
    const applied = await next.reconcileSchedules({
      apply: true,
      expectedRevision: preview.revision,
    });
    expect(applied.applied).toBe(true);
    expect(applied.changes).toHaveLength(2);
    await expect(
      next.reconcileSchedules({ apply: true, expectedRevision: preview.revision }),
    ).rejects.toThrow('revision');
    expect((await next.reconcileSchedules()).changes).toEqual([]);
    const [tenantRow] = await tenantA.db.select().from(flows.flowSchedulesTable);
    expect(tenantRow).toMatchObject({ cron: 'every:3h', revision: 2 });
  });

  it('places tenant runs on their plane with spine dispatch, claimable through the hint', async () => {
    const { registry, engine } = setup(
      { spineJob: { cron: 'every:1h', plane: 'spine' }, tenantJob: { cron: 'every:1h' } },
      { 'tenant-a': tenantA },
    );
    const scheduler = createFlowScheduler({
      db: pool.db,
      registry,
      engine,
      logger,
      resolver: resolver({ 'tenant-a': tenantA }),
      listTenantRefs: () => ['tenant-a'],
    });
    expect(await scheduler.syncSchedules()).toBe(2);
    expect(await scheduler.poll()).toBe(2);
    const [tenantExec] = await tenantA.db.select().from(flows.flowExecutionsTable);
    expect(tenantExec).toMatchObject({ flowName: 'tenantJob', tenantId: 'tenant-a' });
    const [poolExec] = await pool.db.select().from(flows.flowExecutionsTable);
    expect(poolExec).toMatchObject({ flowName: 'spineJob', tenantId: null });
    expect(await tenantA.db.select().from(flows.flowScheduleTicksTable)).toHaveLength(1);
    expect(await pool.db.select().from(flows.flowScheduleTicksTable)).toHaveLength(1);
    const hints = (await pool.db.execute(
      sql`SELECT execution_id FROM opaque_dispatch WHERE delivery_state = 'ready'`,
    )) as unknown as Array<{ execution_id: string }>;
    expect(hints.map((hint) => hint.execution_id)).toEqual([tenantExec?.id]);
    expect((await engine.claimNext(5)).map((row) => row.id).sort()).toEqual(
      [tenantExec?.id, poolExec?.id].sort(),
    );
  });

  it('commits tenant ticks and executions on the pool under tenantExecutions pool', async () => {
    const { registry, engine } = setup({ tenantJob: { cron: 'every:1h' } });
    const scheduler = createFlowScheduler({
      db: pool.db,
      registry,
      engine,
      logger,
      resolver: resolver({ 'tenant-a': tenantA }),
      listTenantRefs: () => ['tenant-a'],
      tenantExecutions: 'pool',
    });
    expect(await scheduler.syncSchedules()).toBe(1);
    expect(await scheduler.poll()).toBe(1);
    expect(await pool.db.select().from(flows.flowExecutionsTable)).toMatchObject([
      { flowName: 'tenantJob', tenantId: 'tenant-a' },
    ]);
    expect(await pool.db.select().from(flows.flowScheduleTicksTable)).toHaveLength(1);
    expect(await tenantA.db.select().from(flows.flowScheduleTicksTable)).toHaveLength(0);
    expect(await tenantA.db.select().from(flows.flowExecutionsTable)).toHaveLength(0);
    const [row] = await tenantA.db.select().from(flows.flowSchedulesTable);
    expect(row?.lastRunAt).not.toBeNull();
    // A plane that did not advance (simulated): the next poll's tick conflicts, no duplicate execution.
    await tenantA.db
      .update(flows.flowSchedulesTable)
      .set({
        nextRunAt: row?.lastRunAt
          ? (await pool.db.select().from(flows.flowScheduleTicksTable))[0]?.scheduledFor
          : null,
      })
      .where(eq(flows.flowSchedulesTable.id, row?.id ?? ''));
    expect(await scheduler.poll()).toBe(0);
    expect(await pool.db.select().from(flows.flowExecutionsTable)).toHaveLength(1);
    const [advanced] = await tenantA.db.select().from(flows.flowSchedulesTable);
    expect(advanced?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('creates one tick and execution per caught-up slot; disabled schedules create nothing', async () => {
    const { registry, engine } = setup({
      catchUp: { cron: 'every:1m', catchUpPolicy: 'catch-up' },
      off: { cron: 'every:1m' },
    });
    const scheduler = createFlowScheduler({ db: pool.db, registry, engine, logger, maxCatchUp: 3 });
    await scheduler.syncSchedules();
    await pool.db
      .update(flows.flowSchedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(flows.flowSchedulesTable.flowName, 'catchUp'));
    await pool.db
      .update(flows.flowSchedulesTable)
      .set({ enabled: false })
      .where(eq(flows.flowSchedulesTable.flowName, 'off'));
    expect(await scheduler.poll()).toBe(3);
    expect(await pool.db.select().from(flows.flowScheduleTicksTable)).toHaveLength(3);
    const executions = await pool.db.select().from(flows.flowExecutionsTable);
    expect(executions.map((e) => e.flowName)).toEqual(['catchUp', 'catchUp', 'catchUp']);
    const [row] = await pool.db
      .select()
      .from(flows.flowSchedulesTable)
      .where(eq(flows.flowSchedulesTable.flowName, 'catchUp'));
    expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });
});
