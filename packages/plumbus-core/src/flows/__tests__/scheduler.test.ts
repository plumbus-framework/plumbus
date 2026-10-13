import { describe, expect, it, vi } from 'vitest';
import { FlowRegistry } from '../registry.js';
import { computeNextRun, createFlowScheduler } from '../scheduler.js';

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
