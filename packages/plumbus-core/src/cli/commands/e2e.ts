// ── plumbus e2e ──
// Runs end-to-end browser tests with automatic frontend server lifecycle.
// Starts the frontend dev server, waits for it to be ready, runs vitest
// with the e2e config, and shuts down the server.

import type { Command } from 'commander';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { info, error as logError, warn } from '../utils.js';

/**
 * Heap cap (MB) applied to the spawned frontend dev server (and inherited by
 * its workers). An unbounded Turbopack/webpack dev server under e2e load can
 * consume enough memory to stall the whole machine; with the cap it crashes
 * loudly instead and the run fails fast.
 */
const SERVER_MAX_OLD_SPACE_MB = 4096;

/**
 * Reject when something is already listening on the port — almost always an
 * orphaned server from a previous interrupted run (or a concurrent checkout).
 * Starting a second server behind it would test the WRONG server while the
 * new one spins compiling for nobody.
 */
export function assertPortFree(port: number, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      probe.close();
      if (err.code === 'EADDRINUSE') {
        rejectPort(
          new Error(
            `Port ${port} is already in use — likely an orphaned frontend server from a previous e2e run. ` +
              `Kill it (e.g. \`pkill -f "next dev --port ${port}"\`) or pass --skip-server to test against it.`,
          ),
        );
        return;
      }
      rejectPort(err);
    });
    probe.once('listening', () => {
      probe.close(() => resolvePort());
    });
    probe.listen(port, host);
  });
}

/**
 * Append a heap cap to NODE_OPTIONS unless the caller already set one.
 */
export function mergeNodeOptions(existing: string | undefined, capMb: number): string {
  const base = existing?.trim() ?? '';
  if (base.includes('--max-old-space-size')) {
    return base;
  }
  const capFlag = `--max-old-space-size=${capMb}`;
  return base ? `${base} ${capFlag}` : capFlag;
}

/**
 * Spawn a tiny detached watchdog that SIGKILLs the server's process group if
 * the CLI process disappears without running its cleanup (SIGKILL, crash,
 * terminated session). Without it, the detached `next dev` group survives as
 * an orphan and keeps compiling/watching forever. The watchdog exits by
 * itself as soon as the server group is gone. (Verified 2026-08-16: the whole
 * dev-server tree stays in the spawn group and dies within ~3s of a group
 * SIGTERM, so group-level kills are sufficient.)
 */
export function spawnOrphanWatchdog(cliPid: number, serverPid: number): number | undefined {
  const script = [
    'const [cli, grp] = process.argv.slice(1).map(Number);',
    'let termedAt = 0;',
    'setInterval(() => {',
    '  try { process.kill(-grp, 0); } catch { process.exit(0); }',
    '  if (termedAt) {',
    '    if (Date.now() - termedAt > 5000) {',
    '      try { process.kill(-grp, "SIGKILL"); } catch {}',
    '      process.exit(0);',
    '    }',
    '    return;',
    '  }',
    '  try { process.kill(cli, 0); } catch {',
    '    termedAt = Date.now();',
    '    try { process.kill(-grp, "SIGTERM"); } catch {}',
    '  }',
    '}, 1000);',
  ].join('\n');
  const watchdog = spawn(process.execPath, ['-e', script, String(cliPid), String(serverPid)], {
    detached: true,
    stdio: 'ignore',
  });
  watchdog.unref();
  return watchdog.pid;
}

interface E2EOptions {
  frontendDir?: string;
  port?: string;
  baseUrl?: string;
  config?: string;
  skipServer?: boolean;
}

/**
 * Resolve the frontend listen port from `--port` or `PLUMBUS_E2E_PORT`.
 * No default port is assumed.
 */
export function resolveE2EPort(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromFlag = explicit?.trim();
  const raw = fromFlag || env.PLUMBUS_E2E_PORT?.trim();
  if (!raw) {
    throw new Error(
      '--port is required (or set PLUMBUS_E2E_PORT). No default listen port is assumed.',
    );
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port "${raw}". Expected an integer in 1-65535 from --port or PLUMBUS_E2E_PORT.`,
    );
  }
  return port;
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
    .option('--port <port>', 'Port for the frontend dev server (or set PLUMBUS_E2E_PORT)')
    .option('--base-url <url>', 'Base URL for the frontend server')
    .option('--config <path>', 'Vitest e2e config file path')
    .option('--skip-server', 'Skip starting the frontend server (assume already running)')
    .allowUnknownOption()
    .action(async (options: E2EOptions, cmd) => {
      const cwd = process.cwd();
      let port: string | undefined;
      let baseUrl: string;
      try {
        if (!options.skipServer) {
          port = String(resolveE2EPort(options.port));
          baseUrl = options.baseUrl?.trim() || `http://localhost:${port}`;
        } else if (options.baseUrl?.trim()) {
          baseUrl = options.baseUrl.trim();
        } else {
          port = String(resolveE2EPort(options.port));
          baseUrl = `http://localhost:${port}`;
        }
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
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
      let vitestChild: ChildProcess | undefined;

      // Cleanup must also run when the CLI itself is signalled mid-run —
      // without this, Ctrl-C/SIGTERM kills the CLI but the detached server
      // group never receives the terminal's signal and survives as an orphan.
      const onSignal = (signal: NodeJS.Signals): void => {
        if (serverProcess?.pid) {
          try {
            process.kill(-serverProcess.pid, 'SIGKILL');
          } catch {
            // Already gone
          }
        }
        if (vitestChild?.pid) {
          try {
            vitestChild.kill(signal);
          } catch {
            // Already gone
          }
        }
        process.exit(signal === 'SIGINT' ? 130 : 143);
      };

      try {
        // ── Start frontend server ──
        if (!options.skipServer) {
          if (!port) {
            logError('--port is required (or set PLUMBUS_E2E_PORT) when starting the frontend server.');
            process.exitCode = 1;
            return;
          }
          await assertPortFree(Number(port));

          info(`Starting frontend dev server on port ${port}...`);
          serverProcess = spawn('npx', ['next', 'dev', '--port', port], {
            cwd: frontendDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
            env: {
              ...process.env,
              PORT: port,
              NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS, SERVER_MAX_OLD_SPACE_MB),
              NEXT_TELEMETRY_DISABLED: '1',
            },
          });

          if (serverProcess.pid) {
            spawnOrphanWatchdog(process.pid, serverProcess.pid);
          }
          process.once('SIGINT', onSignal);
          process.once('SIGTERM', onSignal);
          process.once('SIGHUP', onSignal);

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

        // Async spawn (not execFileSync): a blocked event loop cannot run the
        // signal handlers above, which would resurrect the orphan-server hole.
        const vitestExit = await new Promise<number>((resolveExit, rejectSpawn) => {
          const child = spawn('node', [bin, ...vitestArgs], {
            stdio: 'inherit',
            cwd,
            env: {
              ...process.env,
              NODE_PATH: nodePath,
              E2E_BASE_URL: baseUrl,
            },
          });
          vitestChild = child;
          child.once('error', rejectSpawn);
          child.once('exit', (code, signal) => {
            resolveExit(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : (code ?? 1));
          });
        });
        vitestChild = undefined;

        if (vitestExit !== 0) {
          process.exitCode = vitestExit;
          logError('E2E test run failed');
          return;
        }

        info('E2E tests passed.');
      } catch (err) {
        logError(err instanceof Error ? err.message : 'E2E test run failed');
        process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGHUP', onSignal);

        // ── Shut down server ──
        if (serverProcess?.pid) {
          info('Shutting down frontend server...');

          // Stop listeners to prevent log output during shutdown
          serverProcess.stderr?.removeAllListeners();
          serverProcess.stdout?.removeAllListeners();

          // Destroy piped streams so they can't keep the event loop alive
          serverProcess.stdout?.destroy();
          serverProcess.stderr?.destroy();

          // Detach from event loop so Node can exit once cleanup is done
          serverProcess.unref();

          // Kill the entire process group (npx + next dev + workers)
          const pid = serverProcess.pid;
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            // Already exited
          }

          // Failsafe: if the event loop is still alive after 3s, force-kill and
          // exit. If the CLI exits before this timer fires, the detached
          // watchdog notices the CLI is gone and SIGKILLs the group instead.
          const code = process.exitCode ?? 0;
          setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Already exited
            }
            process.exit(code);
          }, 3000).unref();
        }
      }
    });
}
