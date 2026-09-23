import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const { testRunOptions } = await import(
  new URL('../../../../scripts/test.mjs', import.meta.url).href
);

describe('bounded framework test runner', () => {
  it('defaults to two package tasks and two workers, preserving other environment settings', () => {
    const options = testRunOptions(['--filter=@plumbus/ai-decision-laya'], {
      NODE_OPTIONS: '--max-old-space-size=512',
    });
    expect(options.args).toEqual([
      'run',
      'test',
      '--concurrency=2',
      '--filter=@plumbus/ai-decision-laya',
    ]);
    expect(options.env).toMatchObject({
      VITEST_MAX_FORKS: '2',
      VITEST_MIN_FORKS: '1',
      VITEST_MAX_THREADS: '2',
      VITEST_MIN_THREADS: '1',
      NODE_OPTIONS: '--max-old-space-size=512',
    });
  });
  it.each([
    ['--concurrency=1'],
    ['--concurrency', '1'],
  ])('accepts explicit package concurrency without duplicate flags: %j', (...args) => {
    expect(testRunOptions(args, {}).args).toEqual(['run', 'test', ...args]);
  });
  it('preserves explicit worker controls from the environment and forwarded CLI arguments', () => {
    expect(
      testRunOptions([], { VITEST_MAX_THREADS: '1', VITEST_MAX_FORKS: '1' }).env,
    ).toMatchObject({ VITEST_MAX_THREADS: '1', VITEST_MAX_FORKS: '1' });
    const args = ['--filter=@plumbus/ai-decision-laya', '--', '--maxWorkers=1', '--minWorkers=1'];
    const options = testRunOptions(args, {});
    expect(options.args.slice(-args.length)).toEqual(args);
    expect(options.env.VITEST_MAX_THREADS).toBeUndefined();
    expect(options.env.VITEST_MIN_FORKS).toBeUndefined();
  });
  it('runs Turbo with filtering and a concurrency override without running any tests', () => {
    const runner = fileURLToPath(new URL('../../../../scripts/test.mjs', import.meta.url));
    const output = execFileSync(
      process.execPath,
      [runner, '--filter=@plumbus/ai-decision-laya', '--concurrency=1', '--dry=json'],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const plan = JSON.parse(output);
    expect(
      plan.tasks.some(
        (task: { taskId: string }) => task.taskId === '@plumbus/ai-decision-laya#test',
      ),
    ).toBe(true);
  });
});
