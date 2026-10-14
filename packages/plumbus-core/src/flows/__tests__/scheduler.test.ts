import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import type { LoggerService } from '../../types/context.js';
import { FlowStepType } from '../../types/enums.js';
import { type FlowSchedule, ScheduleCatchUpPolicy } from '../../types/flow.js';
import { FlowRegistry } from '../registry.js';
import {
  computeNextRun,
  createFlowScheduler,
  planMissedSchedule,
  scheduleFingerprint,
} from '../scheduler.js';

describe('scheduler lifecycle', () => {
  it('starts once and stops its timer', async () => {
    const db = { transaction: vi.fn(async () => []) };
    const scheduler = createFlowScheduler({
      db: db as any,
      registry: new FlowRegistry(),
      engine: { wake: vi.fn() } as any,
    });
    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });
  it('shares an active poll and waits for it during shutdown', async () => {
    let release: (value: string[]) => void = () => {};
    const db = {
      transaction: vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const scheduler = createFlowScheduler({
      db: db as any,
      registry: new FlowRegistry(),
      engine: { wake: vi.fn() } as any,
    });
    const first = scheduler.poll();
    const second = scheduler.poll();
    expect(first).toBe(second);
    let stopped = false;
    const stop = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release([]);
    await stop;
    expect(await first).toBe(0);
  });
  it('logs a failed poll with its reason and keeps polling', async () => {
    vi.useFakeTimers();
    try {
      const db = { transaction: vi.fn().mockRejectedValue(new Error('CONNECT_TIMEOUT')) };
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const scheduler = createFlowScheduler({
        db: db as any,
        registry: new FlowRegistry(),
        engine: { wake: vi.fn() } as any,
        logger,
        pollIntervalMs: 1_000,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);
      await scheduler.stop();
      expect(db.transaction).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        'Scheduler poll failed; durable ticks remain recoverable',
        { error: 'CONNECT_TIMEOUT' },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('one cron implementation', () => {
  it.each([
    ['every:30m', 1800000],
    ['every:2h', 7200000],
    ['every:1d', 86400000],
  ])('supports %s', (cron, duration) => {
    const from = new Date('2025-01-01T00:00:00Z');
    expect(computeNextRun(cron as string, from).getTime() - from.getTime()).toBe(duration);
  });
  it.each([
    'not-a-cron',
    'every:0m',
    '5junk * * * *',
    '* * * * 9',
  ])('rejects %s instead of silently changing the schedule', (cron) => {
    expect(() => computeNextRun(cron, new Date())).toThrow();
  });
  it('uses the specified timezone across DST and accepts Sunday aliases', () => {
    expect(
      computeNextRun(
        '0 9 * * *',
        new Date('2026-03-07T15:00:00Z'),
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-03-08T13:00:00.000Z');
    const from = new Date('2026-01-01T00:00:00Z');
    expect(computeNextRun('0 0 * * 7', from, 'UTC')).toEqual(
      computeNextRun('0 0 * * SUN', from, 'UTC'),
    );
    expect(() => computeNextRun('0 0 * * *', from, 'not/a-zone')).toThrow();
  });
});

// ── Transactional poll over schedule planes (mocked databases) ──

/**
 * A plane database whose transaction (and savepoints) hand the callback one `tx`: the due
 * select returns `dueRows`, the overlap probe finds nothing, tick inserts return their id.
 */
function planeDb(dueRows: any[] = []) {
  const tx: any = {
    execute: vi.fn(async () => [{ now: new Date() }]),
    select: vi.fn((fields?: unknown) => {
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => (fields ? Promise.resolve([]) : chain)),
        for: vi.fn(async () => dueRows),
      };
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((value: { id?: string }) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: value.id }]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  };
  tx.transaction = vi.fn(async (fn: (savepoint: unknown) => unknown) => fn(tx));
  return { tx, transaction: vi.fn(async (fn: (handle: unknown) => unknown) => fn(tx)) } as any;
}

/** `placesTenantExecutions` models an engine with spine dispatch (the worker's under a resolver). */
function mockEngine(
  fails: (flowName: string) => boolean = () => false,
  { placesTenantExecutions = true }: { placesTenantExecutions?: boolean } = {},
) {
  return {
    placesTenantExecutions,
    createExecution: vi.fn(
      async (
        _store: unknown,
        flowName: string,
        _input: unknown,
        _auth: unknown,
        opts: { executionId: string },
      ) => {
        if (fails(flowName)) throw new Error('engine failure');
        return {
          id: opts.executionId,
          flowName,
          status: 'created',
          correlationId: opts.executionId,
        };
      },
    ),
    announceExecution: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
  };
}

function silentLogger(): LoggerService {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function scheduledFlow(name: string, schedule: FlowSchedule) {
  return defineFlow({
    name,
    domain: 'ops',
    input: z.object({}),
    schedule,
    steps: [{ name: 'tick', type: FlowStepType.Capability }],
  });
}

function registryOf(...flows: ReturnType<typeof scheduledFlow>[]) {
  const registry = new FlowRegistry();
  for (const flow of flows) registry.register(flow);
  return registry;
}

/** A due `flow_schedules` row adopted for `flow`'s current definition. */
function dueRow(flow: ReturnType<typeof scheduledFlow>, overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    flowName: flow.name,
    cron: flow.schedule?.cron,
    enabled: true,
    removed: false,
    nextRunAt: new Date(Date.now() - 1_000),
    revision: 1,
    timezone: null,
    overlap: 'allow',
    adoptedAt: new Date(0),
    definitionHash: scheduleFingerprint(flow),
    ...overrides,
  };
}

function tenantResolver(planes: Record<string, unknown>) {
  return {
    resolve: async (tenantRef: string) => ({
      db: planes[tenantRef] as any,
      coreSchema: 'core_plumbus',
      packageSchemaPrefix: 'pkg_',
      tenantRef,
    }),
  };
}

describe('FlowScheduler', () => {
  it('polls and triggers due schedules', async () => {
    const engine = mockEngine();
    const flow = scheduledFlow('daily-report', { cron: 'every:24h' });
    const db = planeDb([dueRow(flow)]);
    const scheduler = createFlowScheduler({
      db,
      registry: registryOf(flow),
      engine: engine as any,
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBe(1);
    expect(engine.createExecution).toHaveBeenCalledWith(
      db.tx,
      'daily-report',
      {},
      expect.objectContaining({ userId: 'system-scheduler' }),
      expect.objectContaining({ scheduleId: 's1' }),
    );
    const created = await engine.createExecution.mock.results[0]?.value;
    expect(engine.announceExecution).toHaveBeenCalledWith(created, {
      store: db,
      auth: expect.objectContaining({ userId: 'system-scheduler' }),
    });
    expect(engine.wake).toHaveBeenCalledWith(created.id);
    expect(db.tx.update).toHaveBeenCalledTimes(1);
  });

  it('skips disabled schedules', async () => {
    const engine = mockEngine();
    const flow = scheduledFlow('disabled-flow', { cron: 'every:1h' });
    const db = planeDb([dueRow(flow, { enabled: false })]);
    const scheduler = createFlowScheduler({
      db,
      registry: registryOf(flow),
      engine: engine as any,
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBe(0);
    expect(engine.createExecution).not.toHaveBeenCalled();
  });

  it('logs errors on failed flow starts instead of swallowing them', async () => {
    const engine = mockEngine(() => true);
    const logger = silentLogger();
    const flow = scheduledFlow('broken-flow', { cron: 'every:1h' });
    const db = planeDb([dueRow(flow)]);
    const scheduler = createFlowScheduler({
      db,
      registry: registryOf(flow),
      engine: engine as any,
      logger,
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler failed to start flow "broken-flow"',
      expect.objectContaining({
        flowName: 'broken-flow',
        error: 'engine failure',
      }),
    );
    // The failed schedule is not advanced: it stays due for the next poll.
    expect(db.tx.update).not.toHaveBeenCalled();
    expect(engine.announceExecution).not.toHaveBeenCalled();
    expect(engine.wake).not.toHaveBeenCalled();
  });

  it('isolates a failing schedule from the others due on the same plane', async () => {
    const engine = mockEngine((flowName) => flowName === 'broken-flow');
    const logger = silentLogger();
    const broken = scheduledFlow('broken-flow', { cron: 'every:1h' });
    const healthy = scheduledFlow('healthy-flow', { cron: 'every:1h' });
    const db = planeDb([dueRow(broken, { id: 's1' }), dueRow(healthy, { id: 's2' })]);
    const scheduler = createFlowScheduler({
      db,
      registry: registryOf(broken, healthy),
      engine: engine as any,
      logger,
    });

    expect(await scheduler.poll()).toBe(1);
    expect(db.tx.transaction).toHaveBeenCalledTimes(2);
    expect(engine.wake).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler failed to start flow "broken-flow"',
      expect.objectContaining({ scheduleId: 's1', error: 'engine failure' }),
    );
  });

  it('skips rows whose flow is not registered or whose definition drifted', async () => {
    const engine = mockEngine();
    const logger = silentLogger();
    const flow = scheduledFlow('daily-report', { cron: 'every:24h' });
    const db = planeDb([
      dueRow(flow, { definitionHash: 'stale' }),
      { ...dueRow(flow, { id: 's2' }), flowName: 'unregistered' },
    ]);
    const scheduler = createFlowScheduler({
      db,
      registry: registryOf(flow),
      engine: engine as any,
      logger,
    });

    expect(await scheduler.poll()).toBe(0);
    expect(engine.createExecution).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Schedule requires reconciliation',
      expect.objectContaining({ flowName: 'daily-report', reason: 'definition_drift' }),
    );
  });

  it('starts and stops the polling timer', async () => {
    const scheduler = createFlowScheduler({
      db: planeDb(),
      registry: new FlowRegistry(),
      engine: mockEngine() as any,
    });

    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it('polls each resolved tenant database and starts with that tenant on auth', async () => {
    const engine = mockEngine();
    const dailyA = scheduledFlow('daily-a', { cron: 'every:24h' });
    const dailyB = scheduledFlow('daily-b', { cron: 'every:24h' });
    const pool = planeDb([dueRow(dailyA, { id: 'pool' })]);
    const tenantA = planeDb([dueRow(dailyA, { id: 'a1' })]);
    const tenantB = planeDb([dueRow(dailyB, { id: 'b1' })]);

    const scheduler = createFlowScheduler({
      db: pool,
      registry: registryOf(dailyA, dailyB),
      engine: engine as any,
      resolver: tenantResolver({ 'tenant-a': tenantA, 'tenant-b': tenantB }),
      listTenantRefs: async () => ['tenant-a', 'tenant-b'],
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBe(2);
    expect(engine.createExecution).toHaveBeenCalledWith(
      tenantA.tx,
      'daily-a',
      {},
      expect.objectContaining({ tenantId: 'tenant-a' }),
      expect.objectContaining({ scheduleId: 'a1' }),
    );
    expect(engine.createExecution).toHaveBeenCalledWith(
      tenantB.tx,
      'daily-b',
      {},
      expect.objectContaining({ tenantId: 'tenant-b' }),
      expect.objectContaining({ scheduleId: 'b1' }),
    );
    expect(engine.announceExecution).toHaveBeenCalledWith(
      expect.objectContaining({ flowName: 'daily-a' }),
      { store: tenantA, auth: expect.objectContaining({ tenantId: 'tenant-a' }) },
    );
    expect(pool.transaction).not.toHaveBeenCalled();
  });

  it('keeps spine-scheduled flows on the pool and tenant-scheduled ones on the planes', async () => {
    const engine = mockEngine();
    const nightlySpine = scheduledFlow('nightly-spine', { cron: 'every:24h', plane: 'spine' });
    const hourlyTenant = scheduledFlow('hourly-tenant', { cron: 'every:1h' });
    // A row left on the wrong plane (the tenant flow's row on the pool) is not started.
    const pool = planeDb([dueRow(nightlySpine, { id: 'p1' }), dueRow(hourlyTenant, { id: 'p2' })]);
    const tenantA = planeDb([dueRow(hourlyTenant, { id: 'a1' })]);
    const scheduler = createFlowScheduler({
      db: pool,
      registry: registryOf(nightlySpine, hourlyTenant),
      engine: engine as any,
      resolver: tenantResolver({ 'tenant-a': tenantA }),
      listTenantRefs: async () => ['tenant-a'],
    });
    const triggered = await scheduler.poll();
    expect(triggered).toBe(2);
    expect(engine.createExecution).toHaveBeenCalledTimes(2);
    expect(engine.createExecution).toHaveBeenCalledWith(
      pool.tx,
      'nightly-spine',
      {},
      expect.not.objectContaining({ tenantId: 'tenant-a' }),
      expect.objectContaining({ scheduleId: 'p1' }),
    );
    expect(engine.createExecution).toHaveBeenCalledWith(
      tenantA.tx,
      'hourly-tenant',
      {},
      expect.objectContaining({ tenantId: 'tenant-a' }),
      expect.objectContaining({ scheduleId: 'a1' }),
    );
  });

  it('creates tenant-plane executions on the pool under tenantExecutions pool', async () => {
    const engine = mockEngine();
    const hourlyTenant = scheduledFlow('hourly-tenant', { cron: 'every:1h' });
    const pool = planeDb([]);
    const tenantA = planeDb([dueRow(hourlyTenant, { id: 'a1' })]);
    const scheduler = createFlowScheduler({
      db: pool,
      registry: registryOf(hourlyTenant),
      engine: engine as any,
      resolver: tenantResolver({ 'tenant-a': tenantA }),
      listTenantRefs: async () => ['tenant-a'],
      tenantExecutions: 'pool',
    });

    expect(await scheduler.poll()).toBe(1);
    // Tick and execution commit together on the pool; the schedule advances on its plane.
    expect(pool.transaction).toHaveBeenCalledTimes(1);
    expect(pool.tx.insert).toHaveBeenCalledTimes(1);
    expect(tenantA.tx.insert).not.toHaveBeenCalled();
    expect(engine.createExecution).toHaveBeenCalledWith(
      pool.tx,
      'hourly-tenant',
      {},
      expect.objectContaining({ tenantId: 'tenant-a' }),
      expect.objectContaining({ scheduleId: 'a1' }),
    );
    expect(tenantA.tx.update).toHaveBeenCalledTimes(1);
    expect(engine.announceExecution).toHaveBeenCalledWith(
      expect.objectContaining({ flowName: 'hourly-tenant' }),
      { store: pool, auth: expect.objectContaining({ tenantId: 'tenant-a' }) },
    );
  });

  it('creates tenant-plane executions on the pool by default when the engine has no spine dispatch', async () => {
    const engine = mockEngine(undefined, { placesTenantExecutions: false });
    const hourlyTenant = scheduledFlow('hourly-tenant', { cron: 'every:1h' });
    const pool = planeDb([]);
    const tenantA = planeDb([dueRow(hourlyTenant, { id: 'a1' })]);
    const scheduler = createFlowScheduler({
      db: pool,
      registry: registryOf(hourlyTenant),
      engine: engine as any,
      resolver: tenantResolver({ 'tenant-a': tenantA }),
      listTenantRefs: async () => ['tenant-a'],
    });

    expect(await scheduler.poll()).toBe(1);
    // A plain engine claims only from its own db: the run must start there, not on the plane.
    expect(engine.createExecution).toHaveBeenCalledWith(
      pool.tx,
      'hourly-tenant',
      {},
      expect.objectContaining({ tenantId: 'tenant-a' }),
      expect.objectContaining({ scheduleId: 'a1' }),
    );
    expect(tenantA.tx.insert).not.toHaveBeenCalled();
    expect(engine.announceExecution).toHaveBeenCalledWith(
      expect.objectContaining({ flowName: 'hourly-tenant' }),
      { store: pool, auth: expect.objectContaining({ tenantId: 'tenant-a' }) },
    );
  });

  it("refuses to poll tenant planes under 'schedule-plane' without spine dispatch", async () => {
    const engine = mockEngine(undefined, { placesTenantExecutions: false });
    const hourlyTenant = scheduledFlow('hourly-tenant', { cron: 'every:1h' });
    const tenantA = planeDb([dueRow(hourlyTenant, { id: 'a1' })]);
    const scheduler = createFlowScheduler({
      db: planeDb([]),
      registry: registryOf(hourlyTenant),
      engine: engine as any,
      resolver: tenantResolver({ 'tenant-a': tenantA }),
      listTenantRefs: async () => ['tenant-a'],
      tenantExecutions: 'schedule-plane',
    });

    await expect(scheduler.poll()).rejects.toThrow('needs a flow engine with spineDispatch');
    expect(tenantA.transaction).not.toHaveBeenCalled();
    expect(engine.createExecution).not.toHaveBeenCalled();
  });

  it('keeps polling the other planes when a tenant plane fails', async () => {
    const engine = mockEngine();
    const logger = silentLogger();
    const daily = scheduledFlow('daily', { cron: 'every:24h' });
    const tenantA = planeDb([dueRow(daily, { id: 'a1' })]);
    const tenantB = planeDb([]);
    tenantB.transaction.mockRejectedValue(new Error('relation "flow_schedules" does not exist'));
    const scheduler = createFlowScheduler({
      db: planeDb(),
      registry: registryOf(daily),
      engine: engine as any,
      logger,
      resolver: tenantResolver({ 'tenant-a': tenantA, 'tenant-b': tenantB }),
      listTenantRefs: async () => ['tenant-b', 'tenant-a'],
    });

    expect(await scheduler.poll()).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler could not read schedules on a plane',
      expect.objectContaining({ tenantRef: 'tenant-b' }),
    );
  });

  it('does not start twice', async () => {
    const scheduler = createFlowScheduler({
      db: planeDb(),
      registry: new FlowRegistry(),
      engine: mockEngine() as any,
    });

    scheduler.start();
    scheduler.start(); // should be idempotent
    expect(scheduler.isRunning).toBe(true);
    await scheduler.stop();
  });
});

describe('planMissedSchedule', () => {
  it('starts once and jumps to the next future slot when skip (default)', () => {
    const now = new Date('2025-01-01T00:05:00Z');
    const due = new Date('2025-01-01T00:01:00Z');
    const plan = planMissedSchedule({
      cron: 'every:1m',
      nextRunAt: due,
      now,
      policy: ScheduleCatchUpPolicy.Skip,
    });
    expect(plan.starts).toBe(1);
    expect(plan.slots).toHaveLength(plan.starts);
    expect(plan.slots[0]).toEqual(due);
    expect(plan.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('catch-up starts once per missed slot up to the bound (E6)', () => {
    const now = new Date('2025-01-01T00:05:00Z');
    const due = new Date('2025-01-01T00:01:00Z');
    const plan = planMissedSchedule({
      cron: 'every:1m',
      nextRunAt: due,
      now,
      policy: ScheduleCatchUpPolicy.CatchUp,
      maxCatchUp: 3,
    });
    expect(plan.starts).toBe(3);
    expect(plan.slots).toHaveLength(plan.starts);
    expect(plan.slots.map((slot) => slot.toISOString())).toEqual([
      '2025-01-01T00:01:00.000Z',
      '2025-01-01T00:02:00.000Z',
      '2025-01-01T00:03:00.000Z',
    ]);
    expect(plan.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('does not create an unbounded backlog', () => {
    const now = new Date('2025-01-01T01:00:00Z');
    const due = new Date('2025-01-01T00:00:00Z');
    const plan = planMissedSchedule({
      cron: 'every:1m',
      nextRunAt: due,
      now,
      policy: ScheduleCatchUpPolicy.CatchUp,
      maxCatchUp: 3,
    });
    expect(plan.starts).toBe(3);
    expect(plan.slots).toHaveLength(plan.starts);
    expect(plan.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('FlowScheduler missed-schedule catch-up', () => {
  it('starts a flow once per missed tick when catchUpPolicy is catch-up', async () => {
    const engine = mockEngine();
    const flow = scheduledFlow('nightly', { cron: 'every:1m', catchUpPolicy: 'catch-up' });
    const db = planeDb([dueRow(flow, { nextRunAt: new Date(Date.now() - 3 * 60_000) })]);
    const scheduler = createFlowScheduler({
      db,
      registry: registryOf(flow),
      engine: engine as any,
      maxCatchUp: 3,
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBeGreaterThanOrEqual(2);
    expect(triggered).toBeLessThanOrEqual(3);
    expect(engine.createExecution).toHaveBeenCalledTimes(triggered);
    // One durable tick per started slot, then one advance of the schedule.
    expect(db.tx.insert).toHaveBeenCalledTimes(triggered);
    expect(db.tx.update).toHaveBeenCalledTimes(1);
  });
});
