// ── plumbus test ──
// Wraps vitest so consumer apps don't need a direct vitest dependency.
// All arguments are forwarded to vitest.
// Use --all to run both unit and e2e tests.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { info, error as logError } from '../utils.js';

const VITEST_SUBCOMMANDS = new Set([
  'run',
  'watch',
  'dev',
  'bench',
  'related',
  'list',
  'typecheck',
]);

/**
 * Resolve the vitest binary and its parent node_modules from within the framework.
 */
export function resolveVitest(): { bin: string; nodeModulesDir: string } {
  const require = createRequire(import.meta.url);
  const vitestPkg = require.resolve('vitest/package.json');
  return {
    bin: vitestPkg.replace('package.json', 'vitest.mjs'),
    nodeModulesDir: dirname(dirname(vitestPkg)),
  };
}

export function findVitestConfigPath(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === '--config') {
      return args[index + 1];
    }

    if (arg.startsWith('--config=')) {
      return arg.slice('--config='.length);
    }
  }

  return undefined;
}

export function isE2EConfigPath(configPath: string | undefined): boolean {
  if (!configPath) {
    return false;
  }

  return /(^|[/\\])(?:frontend[/\\])?e2e[/\\].*vitest\.config\.e2e\.[cm]?[jt]s$|(^|[/\\])vitest\.config\.e2e\.[cm]?[jt]s$/i.test(
    configPath,
  );
}

function hasExplicitSubcommand(args: string[]): boolean {
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) {
      continue;
    }

    return VITEST_SUBCOMMANDS.has(arg);
  }

  return false;
}

function hasConfigLoader(args: string[]): boolean {
  return args.some((arg) => arg === '--configLoader' || arg.startsWith('--configLoader='));
}

export function normalizeVitestArgs(args: string[]): string[] {
  const normalized = hasExplicitSubcommand(args) ? [...args] : ['run', ...args];
  const configPath = findVitestConfigPath(normalized);

  if (isE2EConfigPath(configPath) && !hasConfigLoader(normalized)) {
    normalized.push('--configLoader', 'runner');
  }

  return normalized;
}

/**
 * Run vitest with the given arguments. Returns true on success, false on failure.
 */
export function runVitest(args: string[]): boolean {
  try {
    const { bin, nodeModulesDir } = resolveVitest();

    const existingNodePath = process.env.NODE_PATH ?? '';
    const nodePath = existingNodePath ? `${nodeModulesDir}:${existingNodePath}` : nodeModulesDir;

    execFileSync('node', [bin, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, NODE_PATH: nodePath },
    });
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
      process.exitCode = err.status;
    } else {
      logError('Failed to run vitest');
      process.exitCode = 1;
    }
    return false;
  }
}

export function registerTestCommand(program: Command): void {
  program
    .command('test')
    .description('Run unit tests using vitest (provided by the framework)')
    .option('--all', 'Run both unit tests and e2e tests')
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(async (_options, cmd) => {
      const allFlag = cmd.opts().all as boolean | undefined;
      // Strip --all from the args passed to vitest
      const args = (cmd.args as string[]).filter((a) => a !== '--all');

      const finalArgs = normalizeVitestArgs(args);

      info(`Running unit tests: vitest ${finalArgs.join(' ')}`);
      const unitPassed = runVitest(finalArgs);

      if (allFlag && unitPassed) {
        info('Unit tests passed. Starting e2e tests...');
        // Delegate to plumbus e2e (which is registered as a sibling command)
        const e2eCmd = program.commands.find((c) => c.name() === 'e2e');
        if (e2eCmd) {
          await e2eCmd.parseAsync([], { from: 'user' });
        } else {
          logError('E2E command not registered. Run `plumbus e2e` separately.');
          process.exitCode = 1;
        }
      } else if (allFlag && !unitPassed) {
        logError('Unit tests failed — skipping e2e tests.');
      }
    });
}
