// ── App boot hook ──
// `export async function onBoot(ctx)` in app/server.ts: the app's own process setup, run once
// per process in every runtime role — `plumbus dev`, `plumbus start` (all, api, worker) and
// `plumbus worker` — before the HTTP server or the worker pool starts. `onRoutesRegistered`
// stays for HTTP concerns (hooks, extra routes); it never runs in a worker-only process.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PlumbusConfig } from '../types/config.js';
import type { LoggerService } from '../types/context.js';
import type { RuntimeCommand, RuntimeRole } from './bootstrap.js';

/** What `onBoot` receives. */
export interface AppBootContext {
  /** The CLI command that started the process. */
  command: RuntimeCommand;
  /** The resolved `PLUMBUS_RUNTIME_ROLE` (`plumbus worker` is always `'worker'`). */
  role: RuntimeRole;
  /** Whether this process serves HTTP (and so will also call `onRoutesRegistered`). */
  servesHttp: boolean;
  /** Whether this process may start the worker pool (it starts one only for background work). */
  runsWorkers: boolean;
  /** The loaded and validated configuration (`config.database` included). */
  config: PlumbusConfig;
  /** The process's main database pool — the same handle routes and workers get. */
  db: PostgresJsDatabase;
  logger: LoggerService;
}

/**
 * Runs once per process before the HTTP server or the worker pool starts. A throw (or a
 * rejection) stops startup: the process exits with the error, so a boot check fails closed.
 */
export type OnBootHook = (context: AppBootContext) => Promise<void> | void;

/** Run the app's boot hook, naming it in the error when it refuses. */
export async function runAppBoot(
  hook: OnBootHook | undefined,
  context: AppBootContext,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(context);
  } catch (error) {
    throw new Error(
      `App boot (onBoot in app/server.ts) failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** The CLI's console output as a `LoggerService` for the boot hook. */
export function bootLogger(sink: {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}): LoggerService {
  const format = (message: string, metadata?: Record<string, unknown>) =>
    metadata ? `${message} ${JSON.stringify(metadata)}` : message;
  return {
    debug: (message, metadata) => sink.info(format(message, metadata)),
    info: (message, metadata) => sink.info(format(message, metadata)),
    warn: (message, metadata) => sink.warn(format(message, metadata)),
    error: (message, metadata) => sink.error(format(message, metadata)),
  };
}
