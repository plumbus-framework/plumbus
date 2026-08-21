import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import type { LoggerService } from '../../types/context.js';
import { FlowStepType } from '../../types/enums.js';
import { ScheduleCatchUpPolicy } from '../../types/flow.js';
import { FlowRegistry } from '../registry.js';
import { computeNextRun, createFlowScheduler, planMissedSchedule } from '../scheduler.js';

function mockDb(dueSchedules: any[] = []) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(Promise.resolve(dueSchedules)),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  } as any;
}

function mockEngine(succeeds = true) {
  return {
    start: succeeds
      ? vi.fn().mockResolvedValue({ id: 'exec-1', flowName: 'test', status: 'created' })
      : vi.fn().mockRejectedValue(new Error('engine failure')),
    runNext: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    status: vi.fn(),
  };
}

describe('FlowScheduler', () => {
  it('polls and triggers due schedules', async () => {
    const engine = mockEngine();
    const db = mockDb([{ id: 's1', flowName: 'daily-report', cron: 'every:24h', enabled: true }]);
    const scheduler = createFlowScheduler({
      db,
      registry: new FlowRegistry(),
      engine: engine as any,
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBe(1);
    expect(engine.start).toHaveBeenCalledWith('daily-report', {}, expect.any(Object));
  });

  it('skips disabled schedules', async () => {
    const engine = mockEngine();
    const db = mockDb([{ id: 's1', flowName: 'disabled-flow', cron: 'every:1h', enabled: false }]);
    const scheduler = createFlowScheduler({
      db,
      registry: new FlowRegistry(),
      engine: engine as any,
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBe(0);
    expect(engine.start).not.toHaveBeenCalled();
  });

  it('logs errors on failed flow starts instead of swallowing them', async () => {
    const engine = mockEngine(false);
    const logger: LoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const db = mockDb([{ id: 's1', flowName: 'broken-flow', cron: 'every:1h', enabled: true }]);
    const scheduler = createFlowScheduler({
      db,
      registry: new FlowRegistry(),
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
  });

  it('starts and stops the polling timer', () => {
    const scheduler = createFlowScheduler({
      db: mockDb(),
      registry: new FlowRegistry(),
      engine: mockEngine() as any,
    });

    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it('polls each resolved tenant database and starts with that tenant on auth', async () => {
    const engine = mockEngine();
    const pool = mockDb([{ id: 'pool', flowName: 'should-not-run', cron: 'every:1h', enabled: true }]);
    const tenantA = mockDb([{ id: 'a1', flowName: 'daily-a', cron: 'every:24h', enabled: true }]);
    const tenantB = mockDb([{ id: 'b1', flowName: 'daily-b', cron: 'every:24h', enabled: true }]);

    const scheduler = createFlowScheduler({
      db: pool,
      registry: new FlowRegistry(),
      engine: engine as any,
      resolver: {
        resolve: async (tenantRef: string) => ({
          db: tenantRef === 'tenant-a' ? tenantA : tenantB,
          coreSchema: 'core_plumbus',
          packageSchemaPrefix: 'pkg_',
          tenantRef,
        }),
      },
      listTenantRefs: async () => ['tenant-a', 'tenant-b'],
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBe(2);
    expect(engine.start).toHaveBeenCalledWith(
      'daily-a',
      {},
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
    expect(engine.start).toHaveBeenCalledWith(
      'daily-b',
      {},
      expect.objectContaining({ tenantId: 'tenant-b' }),
    );
    expect(pool.select).not.toHaveBeenCalled();
  });

  it('does not start twice', () => {
    const scheduler = createFlowScheduler({
      db: mockDb(),
      registry: new FlowRegistry(),
      engine: mockEngine() as any,
    });

    scheduler.start();
    scheduler.start(); // should be idempotent
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
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
    expect(plan.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('FlowScheduler missed-schedule catch-up', () => {
  it('starts a flow once per missed tick when catchUpPolicy is catch-up', async () => {
    const engine = mockEngine();
    const now = new Date();
    const due = new Date(now.getTime() - 3 * 60_000);
    const db = mockDb([
      {
        id: 's1',
        flowName: 'nightly',
        cron: 'every:1m',
        enabled: true,
        nextRunAt: due,
      },
    ]);
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'nightly',
        domain: 'ops',
        input: z.object({}),
        schedule: { cron: 'every:1m', catchUpPolicy: 'catch-up' },
        steps: [{ name: 'tick', type: FlowStepType.Capability }],
      }),
    );
    const scheduler = createFlowScheduler({
      db,
      registry,
      engine: engine as any,
      maxCatchUp: 3,
    });

    const triggered = await scheduler.poll();
    expect(triggered).toBeGreaterThanOrEqual(2);
    expect(triggered).toBeLessThanOrEqual(3);
    expect(engine.start).toHaveBeenCalledTimes(triggered);
    expect(db.update).toHaveBeenCalled();
  });
});

describe('computeNextRun', () => {
  it('computes next run for minute interval', () => {
    const from = new Date('2025-01-01T00:00:00Z');
    const next = computeNextRun('every:30m', from);
    expect(next.getTime() - from.getTime()).toBe(30 * 60_000);
  });

  it('computes next run for hour interval', () => {
    const from = new Date('2025-01-01T00:00:00Z');
    const next = computeNextRun('every:2h', from);
    expect(next.getTime() - from.getTime()).toBe(2 * 3_600_000);
  });

  it('computes next run for day interval', () => {
    const from = new Date('2025-01-01T00:00:00Z');
    const next = computeNextRun('every:1d', from);
    expect(next.getTime() - from.getTime()).toBe(86_400_000);
  });
});
