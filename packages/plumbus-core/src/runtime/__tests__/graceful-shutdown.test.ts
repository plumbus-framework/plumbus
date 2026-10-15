import { describe, expect, it, vi } from 'vitest';
import {
  createShutdownBudget,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  resolveShutdownSettings,
  runGracefulShutdown,
  type GracefulShutdownPlan,
} from '../graceful-shutdown.js';

const quietLog = () => ({ info: vi.fn(), error: vi.fn() });

function recordingPlan(order: string[], overrides: Partial<GracefulShutdownPlan> = {}) {
  const exit = vi.fn();
  const plan: GracefulShutdownPlan = {
    settings: { timeoutMs: 2_000, drainDelayMs: 0 },
    signal: 'SIGTERM',
    log: quietLog(),
    markNotReady: () => order.push('ready-off'),
    closeHttp: async () => {
      order.push('http');
    },
    stopWorkers: async () => {
      order.push('workers');
      return true;
    },
    onShutdown: async () => {
      order.push('hook');
    },
    closeQueues: async () => {
      order.push('queues');
    },
    closeDatabase: async () => {
      order.push('database');
    },
    closeHealth: async () => {
      order.push('health');
    },
    exit,
    ...overrides,
  };
  return { plan, exit };
}

describe('resolveShutdownSettings', () => {
  it('keeps the 10 s deadline and no drain delay by default', () => {
    expect(resolveShutdownSettings({})).toEqual({
      timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      drainDelayMs: 0,
    });
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it('reads PLUMBUS_SHUTDOWN_TIMEOUT_MS and PLUMBUS_SHUTDOWN_DRAIN_DELAY_MS', () => {
    expect(
      resolveShutdownSettings({
        PLUMBUS_SHUTDOWN_TIMEOUT_MS: '45000',
        PLUMBUS_SHUTDOWN_DRAIN_DELAY_MS: '5000',
      }),
    ).toEqual({ timeoutMs: 45_000, drainDelayMs: 5_000 });
  });

  it('refuses malformed values and a drain delay as long as the deadline', () => {
    for (const value of ['abc', '1.5', '999', '-1', '3600001']) {
      expect(() => resolveShutdownSettings({ PLUMBUS_SHUTDOWN_TIMEOUT_MS: value })).toThrow(
        /PLUMBUS_SHUTDOWN_TIMEOUT_MS/,
      );
    }
    expect(() =>
      resolveShutdownSettings({
        PLUMBUS_SHUTDOWN_TIMEOUT_MS: '5000',
        PLUMBUS_SHUTDOWN_DRAIN_DELAY_MS: '5000',
      }),
    ).toThrow(/must be less than/);
  });
});

describe('createShutdownBudget', () => {
  it('keeps the last fifth (at most 2 s) of the deadline for closing queues and the database', () => {
    const now = () => 1_000;
    expect(createShutdownBudget(10_000, 'SIGTERM', now)).toMatchObject({
      signal: 'SIGTERM',
      deadlineAt: 11_000,
      drainDeadlineAt: 9_000,
    });
    expect(createShutdownBudget(5_000, undefined, now).drainDeadlineAt).toBe(5_000);
  });
});

describe('runGracefulShutdown', () => {
  it('turns readiness off first, then drains HTTP, workers, the hook, queues, database, health', async () => {
    const order: string[] = [];
    const { plan, exit } = recordingPlan(order);
    expect(await runGracefulShutdown(plan)).toEqual({ clean: true });
    expect(order).toEqual(['ready-off', 'http', 'workers', 'hook', 'queues', 'database', 'health']);
    expect(exit).not.toHaveBeenCalled();
  });

  it('keeps serving through the drain delay with readiness already off', async () => {
    const order: string[] = [];
    const startedAt = Date.now();
    let httpClosedAfter = 0;
    const { plan } = recordingPlan(order, {
      settings: { timeoutMs: 2_000, drainDelayMs: 200 },
      closeHttp: async () => {
        httpClosedAfter = Date.now() - startedAt;
        order.push('http');
      },
    });
    await runGracefulShutdown(plan);
    expect(order.slice(0, 2)).toEqual(['ready-off', 'http']);
    expect(httpClosedAfter).toBeGreaterThanOrEqual(190);
  });

  it('gives the workers the drain deadline and the hook the signal and deadline', async () => {
    const order: string[] = [];
    const stopWorkers = vi.fn(async () => true);
    const onShutdown = vi.fn();
    const before = Date.now();
    const { plan } = recordingPlan(order, { stopWorkers, onShutdown });
    await runGracefulShutdown(plan);
    const deadline = stopWorkers.mock.calls[0]?.[0] as unknown as number;
    // 2 s timeout: drain deadline is 400 ms before the hard deadline.
    expect(deadline).toBeGreaterThanOrEqual(before + 1_600);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 1_600);
    expect(onShutdown).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM', deadlineAt: deadline + 400 }),
    );
  });

  it('cuts open HTTP connections when the drain deadline passes and still stops the rest', async () => {
    const order: string[] = [];
    const forceCloseHttp = vi.fn();
    const { plan, exit } = recordingPlan(order, {
      settings: { timeoutMs: 1_000, drainDelayMs: 0 },
      closeHttp: () => new Promise<void>(() => {}),
      forceCloseHttp,
    });
    expect(await runGracefulShutdown(plan)).toEqual({ clean: true });
    expect(forceCloseHttp).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['ready-off', 'workers', 'hook', 'queues', 'database', 'health']);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits 1 after closing everything when a step was abandoned at the deadline', async () => {
    const order: string[] = [];
    const { plan, exit } = recordingPlan(order, { stopWorkers: async () => false });
    expect(await runGracefulShutdown(plan)).toEqual({ clean: false });
    expect(order).toContain('database');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('abandons a hook that hangs past the drain deadline, closes the database, then exits 1', async () => {
    const order: string[] = [];
    const { plan, exit } = recordingPlan(order, {
      settings: { timeoutMs: 1_000, drainDelayMs: 0 },
      onShutdown: () => new Promise<void>(() => {}),
    });
    expect(await runGracefulShutdown(plan)).toEqual({ clean: false });
    expect(order).toEqual(['ready-off', 'http', 'workers', 'queues', 'database', 'health']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs a failing phase and carries on', async () => {
    const order: string[] = [];
    const log = quietLog();
    const { plan, exit } = recordingPlan(order, {
      log,
      onShutdown: async () => {
        throw new Error('router close failed');
      },
    });
    expect(await runGracefulShutdown(plan)).toEqual({ clean: true });
    expect(log.error).toHaveBeenCalledWith('onShutdown hook failed: router close failed');
    expect(order).toContain('database');
    expect(exit).not.toHaveBeenCalled();
  });
});
