import { describe, expect, it, vi } from 'vitest';
import { bootLogger, runAppBoot, type AppBootContext } from '../app-boot.js';

const context = {
  command: 'worker',
  role: 'worker',
  servesHttp: false,
  runsWorkers: true,
  config: {} as AppBootContext['config'],
  db: {} as AppBootContext['db'],
  logger: bootLogger({ info: () => {}, warn: () => {}, error: () => {} }),
} satisfies AppBootContext;

describe('runAppBoot', () => {
  it('does nothing without a hook and awaits the hook it is given', async () => {
    await expect(runAppBoot(undefined, context)).resolves.toBeUndefined();
    let finished = false;
    await runAppBoot(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
    }, context);
    expect(finished).toBe(true);
  });

  it('names the hook in the error and keeps the cause', async () => {
    const cause = new Error('router unreachable');
    const failure = await runAppBoot(() => {
      throw cause;
    }, context).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'App boot (onBoot in app/server.ts) failed: router unreachable',
    );
    expect((failure as Error).cause).toBe(cause);
  });
});

describe('bootLogger', () => {
  it('writes through the CLI sink with metadata appended', () => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = bootLogger(sink);
    logger.warn('capacity store shared', { pool: 'request' });
    logger.error('failed');
    expect(sink.warn).toHaveBeenCalledWith('capacity store shared {"pool":"request"}');
    expect(sink.error).toHaveBeenCalledWith('failed');
  });
});
