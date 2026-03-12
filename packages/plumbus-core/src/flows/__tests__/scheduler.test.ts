import { describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '../../types/context.js';
import { FlowRegistry } from '../registry.js';
import { computeNextRun, createFlowScheduler } from '../scheduler.js';

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
