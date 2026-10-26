import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  installKeepAliveProcessHandlers,
  runScript,
  type ProcessErrorInfo,
} from '../process-errors.js';

function setup(
  options: { classify?: (error: unknown) => string | undefined; clock?: { at: number } } = {},
) {
  const target = new EventEmitter();
  const reports: ProcessErrorInfo[] = [];
  const logError = vi.fn();
  const logWarn = vi.fn();
  const uninstall = installKeepAliveProcessHandlers({
    target: target as unknown as NodeJS.Process,
    onProcessError: (info) => {
      reports.push(info);
    },
    ...(options.classify ? { classifyProcessError: options.classify } : {}),
    logError,
    logWarn,
    repeatThreshold: 3,
    repeatWindowMs: 1_000,
    ...(options.clock
      ? {
          now: (
            (clock) => () =>
              clock.at
          )(options.clock),
        }
      : {}),
  });
  return { target, reports, logError, logWarn, uninstall };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('installKeepAliveProcessHandlers', () => {
  it('reports an uncaught exception and an unhandled rejection as errors, and stays attached', async () => {
    const { target, reports, logError } = setup();
    const boom = new TypeError('boom');
    target.emit('uncaughtException', boom);
    target.emit('unhandledRejection', 'plain reason');
    await settle();
    expect(reports).toMatchObject([
      { source: 'uncaughtException', message: 'boom', severity: 'error', error: boom },
      { source: 'unhandledRejection', message: 'plain reason', severity: 'error' },
    ]);
    expect(logError).toHaveBeenCalledTimes(2);
    expect(target.listenerCount('uncaughtException')).toBe(1);
  });

  it('reports a known-harmless error as a warning that never escalates', async () => {
    const harmless = (error: unknown) =>
      error instanceof TypeError && error.message === 'stray write' ? 'stray-write' : undefined;
    const { target, reports, logWarn } = setup({ classify: harmless });
    for (let i = 0; i < 5; i++) target.emit('uncaughtException', new TypeError('stray write'));
    await settle();
    expect(reports).toHaveLength(5);
    expect(reports.every((r) => r.severity === 'warning' && r.known === 'stray-write')).toBe(true);
    expect(logWarn).toHaveBeenCalledTimes(5);
  });

  it('sends one critical report when the same unknown error repeats within the window', async () => {
    const clock = { at: 0 };
    const { target, reports } = setup({ clock });
    const same = () => {
      const error = new Error('db gone');
      error.stack = 'Error: db gone\n    at query (db.js:1:1)';
      return error;
    };
    for (let i = 0; i < 4; i++) target.emit('uncaughtException', same());
    await settle();
    const critical = reports.filter((r) => r.severity === 'critical');
    expect(critical).toHaveLength(1);
    expect(critical[0]?.repeated).toEqual({ count: 3, windowMs: 1_000 });

    clock.at = 5_000; // a new window counts again
    for (let i = 0; i < 3; i++) target.emit('uncaughtException', same());
    await settle();
    expect(reports.filter((r) => r.severity === 'critical')).toHaveLength(2);
  });

  it('keeps going when the report hook or the classifier throws', async () => {
    const target = new EventEmitter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logError = vi.fn();
    installKeepAliveProcessHandlers({
      target: target as unknown as NodeJS.Process,
      onProcessError: () => {
        throw new Error('reporter down');
      },
      classifyProcessError: () => {
        throw new Error('classifier bug');
      },
      logError,
      logWarn: vi.fn(),
    });
    expect(() => target.emit('uncaughtException', new Error('x'))).not.toThrow();
    await settle();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('classifyProcessError failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onProcessError'));
    warn.mockRestore();
  });

  it('detaches its handlers', () => {
    const { target, uninstall } = setup();
    uninstall();
    expect(target.listenerCount('uncaughtException')).toBe(0);
    expect(target.listenerCount('unhandledRejection')).toBe(0);
  });
});

describe('runScript', () => {
  it('reports a failing script, waits for the report, then exits 1', async () => {
    const order: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runScript(
      async () => {
        throw new Error('migration failed');
      },
      {
        onProcessError: async (info) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(`report:${info.source}:${info.message}`);
        },
        exit: (code) => order.push(`exit:${code}`),
      },
    );
    expect(order).toEqual(['report:script:migration failed', 'exit:1']);
    error.mockRestore();
  });

  it('exits even when the report hangs, after the timeout', async () => {
    const exits: number[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runScript(
      () => {
        throw new Error('x');
      },
      {
        onProcessError: () => new Promise(() => undefined),
        reportTimeoutMs: 20,
        exit: (code) => exits.push(code),
      },
    );
    expect(exits).toEqual([1]);
    error.mockRestore();
  });

  it('does not exit when the script succeeds, and removes its handlers', async () => {
    const before = process.listenerCount('uncaughtException');
    const exit = vi.fn();
    await runScript(async () => 'done', { exit });
    expect(exit).not.toHaveBeenCalled();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});
