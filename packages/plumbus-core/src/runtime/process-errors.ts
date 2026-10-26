import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { logHookError } from '../errors/hook-log.js';

/**
 * Process-level errors: what reaches `uncaughtException` / `unhandledRejection`, outside any
 * request, flow step or job (those are already caught and answered by their own runners).
 *
 * Two policies, by the kind of process:
 *
 * - **Long-running** (`plumbus start`, `dev`, `worker`): {@link installKeepAliveProcessHandlers}.
 *   Every such error is reported and the process keeps serving. Node's default would end the
 *   process, taking every request and queued flow step with it.
 * - **One-shot** (migrations, schedule sync, an app's own scripts): {@link runScript}. The error
 *   is reported, then the process exits non-zero, because whoever ran it decides what to do next
 *   from the exit code (a deploy must not go on after a failed migration).
 */

export type ProcessErrorSource =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'fastify'
  | 'startup'
  | 'script';

/** How bad one report is: a known-harmless error, an unknown one, or an unknown one that keeps coming. */
export type ProcessErrorSeverity = 'warning' | 'error' | 'critical';

export interface ProcessErrorInfo {
  source: ProcessErrorSource;
  message: string;
  stack?: string;
  metadata?: Record<string, unknown>;
  db?: PostgresJsDatabase;
  /** The thrown value itself, for reporters that capture it whole (Sentry `captureException`). */
  error?: unknown;
  /** Absent on `fastify` and `startup` reports, which keep their previous meaning. */
  severity?: ProcessErrorSeverity;
  /** The name `classifyProcessError` gave a known-harmless error. */
  known?: string;
  /** Set on the `critical` report sent when the same unknown error repeats within the window. */
  repeated?: { count: number; windowMs: number };
}

export type ProcessErrorHook = (info: ProcessErrorInfo) => void | Promise<void>;

/**
 * Names an error the app knows to be harmless, or returns `undefined` for every other error.
 * Recognise it by structure (error class, code, the frame it was thrown from), never by its
 * wording. A known error is reported as a `warning` and never counts towards `repeated`.
 */
export type ProcessErrorClassifier = (error: unknown) => string | undefined;

export interface KeepAliveOptions {
  onProcessError?: ProcessErrorHook;
  classifyProcessError?: ProcessErrorClassifier;
  logError: (message: string) => void;
  logWarn: (message: string) => void;
  /** The same unknown error this many times within `windowMs` sends one `critical` report. */
  repeatThreshold?: number;
  repeatWindowMs?: number;
  now?: () => number;
  /** The process to attach to; a test passes its own emitter. */
  target?: Pick<NodeJS.Process, 'on' | 'off'>;
}

const DEFAULT_REPEAT_THRESHOLD = 5;
const DEFAULT_REPEAT_WINDOW_MS = 60_000;

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  return { message: String(value ?? 'Unknown rejection') };
}

/** The error class, message and first stack frame: the same failure from the same place. */
function signatureOf(value: unknown, message: string): string {
  if (!(value instanceof Error)) return `value:${message}`;
  const frame = value.stack?.split('\n').find((line) => line.trimStart().startsWith('at ')) ?? '';
  return `${value.name}:${message}:${frame.trim()}`;
}

async function deliver(hook: ProcessErrorHook | undefined, info: ProcessErrorInfo): Promise<void> {
  if (!hook) return;
  try {
    await hook(info);
  } catch (hookError) {
    logHookError('onProcessError', hookError);
  }
}

/**
 * Report every process-level error and keep the process running. Returns a function that
 * removes the handlers.
 */
export function installKeepAliveProcessHandlers(options: KeepAliveOptions): () => void {
  const target = options.target ?? process;
  const threshold = options.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const windowMs = options.repeatWindowMs ?? DEFAULT_REPEAT_WINDOW_MS;
  const now = options.now ?? Date.now;
  const seen = new Map<string, { first: number; count: number; escalated: boolean }>();

  const handle = (source: 'uncaughtException' | 'unhandledRejection', value: unknown) => {
    const { message, stack } = describe(value);
    let known: string | undefined;
    try {
      known = options.classifyProcessError?.(value);
    } catch (classifyError) {
      options.logError(`classifyProcessError failed: ${describe(classifyError).message}`);
    }
    const base = { source, message, ...(stack ? { stack } : {}), error: value };
    if (known) {
      options.logWarn(`Known process error (${known}), kept running: ${message}`);
      void deliver(options.onProcessError, { ...base, severity: 'warning', known });
      return;
    }

    options.logError(
      `${source === 'uncaughtException' ? 'Uncaught exception' : 'Unhandled rejection'}, kept running: ${message}`,
    );
    void deliver(options.onProcessError, { ...base, severity: 'error' });

    const key = signatureOf(value, message);
    const at = now();
    const entry = seen.get(key);
    if (!entry || at - entry.first > windowMs) {
      seen.set(key, { first: at, count: 1, escalated: false });
    } else {
      entry.count += 1;
      if (!entry.escalated && entry.count >= threshold) {
        entry.escalated = true;
        options.logError(
          `The same process error repeated ${entry.count} times within ${windowMs} ms: ${message}`,
        );
        void deliver(options.onProcessError, {
          ...base,
          severity: 'critical',
          repeated: { count: entry.count, windowMs },
        });
      }
    }
    // Bounded: a flood of distinct errors cannot grow the map without limit.
    if (seen.size > 500) {
      for (const [entryKey, value] of seen) {
        if (at - value.first > windowMs) seen.delete(entryKey);
      }
    }
  };

  const onException = (error: Error) => handle('uncaughtException', error);
  const onRejection = (reason: unknown) => handle('unhandledRejection', reason);
  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);
  return () => {
    target.off('uncaughtException', onException);
    target.off('unhandledRejection', onRejection);
  };
}

export interface RunScriptOptions {
  onProcessError?: ProcessErrorHook;
  /** How long a report may take before the script exits anyway. */
  reportTimeoutMs?: number;
  /** Replaces `process.exit` (tests). */
  exit?: (code: number) => void;
}

/**
 * Run a one-shot script: on failure, or on any uncaught error while it runs, report it (waiting
 * up to `reportTimeoutMs`), print it, and exit with code 1.
 */
export async function runScript(
  main: () => unknown | Promise<unknown>,
  options: RunScriptOptions = {},
): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.reportTimeoutMs ?? 5_000;
  let failing = false;

  const fail = async (
    source: 'uncaughtException' | 'unhandledRejection' | 'script',
    value: unknown,
  ) => {
    if (failing) return;
    failing = true;
    const { message, stack } = describe(value);
    console.error(stack ?? message);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      deliver(options.onProcessError, {
        source,
        message,
        ...(stack ? { stack } : {}),
        error: value,
        severity: 'error',
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    exit(1);
  };

  const onException = (error: Error) => void fail('uncaughtException', error);
  const onRejection = (reason: unknown) => void fail('unhandledRejection', reason);
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  try {
    await main();
  } catch (error) {
    await fail('script', error);
  } finally {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  }
}
