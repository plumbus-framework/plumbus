// Bound both layers of test parallelism without changing build/dev commands.
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function testRunOptions(args = [], environment = process.env) {
  const separator = args.indexOf('--');
  const turboArgs = separator < 0 ? args : args.slice(0, separator);
  const vitestArgs = separator < 0 ? [] : args.slice(separator + 1);
  const hasWorkerOption = (name) =>
    vitestArgs.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  const explicitConcurrency = turboArgs.some(
    (arg) => arg === '--concurrency' || arg.startsWith('--concurrency='),
  );
  return {
    args: ['run', 'test', ...(explicitConcurrency ? [] : ['--concurrency=2']), ...args],
    env: {
      ...environment,
      VITEST_MAX_THREADS:
        environment.VITEST_MAX_THREADS ?? (hasWorkerOption('maxWorkers') ? undefined : '2'),
      VITEST_MIN_THREADS:
        environment.VITEST_MIN_THREADS ?? (hasWorkerOption('minWorkers') ? undefined : '1'),
      VITEST_MAX_FORKS:
        environment.VITEST_MAX_FORKS ?? (hasWorkerOption('maxWorkers') ? undefined : '2'),
      VITEST_MIN_FORKS:
        environment.VITEST_MIN_FORKS ?? (hasWorkerOption('minWorkers') ? undefined : '1'),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = testRunOptions(process.argv.slice(2));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../node_modules/turbo/bin/turbo', import.meta.url)), ...options.args],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), env: options.env, stdio: 'inherit' },
  );
  if (result.error) console.error(`Unable to start tests: ${result.error.message}`);
  process.exitCode =
    result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 1) : 1);
}
