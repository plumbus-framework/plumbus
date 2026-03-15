// ── plumbus e2e ──
// Runs end-to-end browser tests with automatic frontend server lifecycle.
// Starts the frontend dev server, waits for it to be ready, runs vitest
// with the e2e config, and shuts down the server.

import type { Command } from 'commander';
import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { info, error as logError, warn } from '../utils.js';

interface E2EOptions {
  frontendDir?: string;
  port?: string;
  baseUrl?: string;
  config?: string;
  skipServer?: boolean;
}

/**
 * Resolve the vitest binary and its parent node_modules from within the framework.
 */
function resolveVitest(): { bin: string; nodeModulesDir: string } {
  const require = createRequire(import.meta.url);
  const vitestPkg = require.resolve('vitest/package.json');
  return {
    bin: vitestPkg.replace('package.json', 'vitest.mjs'),
    nodeModulesDir: dirname(dirname(vitestPkg)),
  };
}

/**
 * Wait for the server to respond to HTTP requests.
 */
async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Detect the e2e vitest config file (convention-based).
 */
function findE2EConfig(cwd: string): string | undefined {
  const candidates = [
    'frontend/e2e/vitest.config.e2e.ts',
    'e2e/vitest.config.e2e.ts',
    'vitest.config.e2e.ts',
  ];
  for (const candidate of candidates) {
    if (existsSync(join(cwd, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

export function registerE2ECommand(program: Command): void {
  program
    .command('e2e')
    .description('Run end-to-end browser tests (auto-starts frontend server)')
    .option('--frontend-dir <dir>', 'Frontend directory with package.json', 'frontend')
    .option('--port <port>', 'Port for the frontend dev server', '3001')
    .option('--base-url <url>', 'Base URL for the frontend server')
    .option('--config <path>', 'Vitest e2e config file path')
    .option('--skip-server', 'Skip starting the frontend server (assume already running)')
    .allowUnknownOption()
    .action(async (options: E2EOptions, cmd) => {
      const cwd = process.cwd();
      const port = options.port ?? '3001';
      const baseUrl = options.baseUrl ?? `http://localhost:${port}`;
      const frontendDir = resolve(cwd, options.frontendDir ?? 'frontend');
      const configPath = options.config ?? findE2EConfig(cwd);

      if (!configPath) {
        logError(
          'No e2e config found. Expected one of: frontend/e2e/vitest.config.e2e.ts, e2e/vitest.config.e2e.ts, vitest.config.e2e.ts',
        );
        logError('Specify one with --config <path>');
        process.exitCode = 1;
        return;
      }

      if (!options.skipServer && !existsSync(join(frontendDir, 'package.json'))) {
        logError(`Frontend directory not found: ${frontendDir}`);
        logError('Specify the frontend directory with --frontend-dir <dir> or use --skip-server');
        process.exitCode = 1;
        return;
      }

      let serverProcess: ChildProcess | undefined;

      try {
        // ── Start frontend server ──
        if (!options.skipServer) {
          info(`Starting frontend dev server on port ${port}...`);
          serverProcess = spawn('npx', ['next', 'dev', '--port', port], {
            cwd: frontendDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: port },
          });

          // Log server output for debugging
          serverProcess.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
              warn(`[frontend] ${msg}`);
            }
          });

          // Wait for the server to be ready
          info('Waiting for frontend server to be ready...');
          const ready = await waitForServer(baseUrl, 60_000);
          if (!ready) {
            logError(`Frontend server did not start within 60s at ${baseUrl}`);
            process.exitCode = 1;
            return;
          }
          info('Frontend server is ready.');
        } else {
          info(`Skipping server start — using ${baseUrl}`);
        }

        // ── Run e2e tests ──
        const { bin, nodeModulesDir } = resolveVitest();

        // Collect extra vitest args (anything after known options)
        const extraArgs = cmd.args.filter((a: string) => a !== options.config);

        const vitestArgs = [
          'run',
          '--config',
          configPath,
          '--configLoader',
          'runner',
          ...extraArgs,
        ];

        info(`Running e2e tests: vitest ${vitestArgs.join(' ')}`);

        const existingNodePath = process.env.NODE_PATH ?? '';
        const nodePath = existingNodePath
          ? `${nodeModulesDir}:${existingNodePath}`
          : nodeModulesDir;

        execFileSync('node', [bin, ...vitestArgs], {
          stdio: 'inherit',
          cwd,
          env: {
            ...process.env,
            NODE_PATH: nodePath,
            E2E_BASE_URL: baseUrl,
          },
        });

        info('E2E tests passed.');
      } catch (err) {
        if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
          process.exitCode = err.status;
        } else {
          logError('E2E test run failed');
          process.exitCode = 1;
        }
      } finally {
        // ── Shut down server ──
        if (serverProcess) {
          info('Shutting down frontend server...');
          serverProcess.kill('SIGTERM');
          // Give it a moment to shut down gracefully
          await new Promise((r) => setTimeout(r, 1000));
          if (!serverProcess.killed) {
            serverProcess.kill('SIGKILL');
          }
        }
      }
    });
}
