// ── Graceful shutdown ──
// One deadline for a process's whole shutdown (`plumbus start`, `plumbus worker`): readiness
// first, then HTTP, then workers, then the host's own resources, then queues and the database.

/** `PLUMBUS_SHUTDOWN_TIMEOUT_MS` when unset: the 10 s every process used before it existed. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Upper bound on any shutdown setting, so a typo cannot keep a terminating pod alive for days. */
const MAX_SHUTDOWN_MS = 3_600_000;

/** What `export const onShutdown` in `app/server.ts` receives. */
export interface ShutdownContext {
  /** The signal that started the shutdown; absent when the caller invoked it directly. */
  signal?: string;
  /** Epoch milliseconds by which the process exits, cleanly or not. */
  deadlineAt: number;
  /** Milliseconds left before `deadlineAt` (never negative). */
  remainingMs(): number;
}

/**
 * Host hook to close resources the framework does not own (tenant routers, extra pools, SDK
 * clients). Runs after HTTP is drained and workers have stopped, before queues and the main
 * database close; a hook still running at the deadline is abandoned.
 */
export type OnShutdownHook = (context: ShutdownContext) => Promise<void> | void;

export interface ShutdownSettings {
  /** Hard deadline for the whole shutdown, from `PLUMBUS_SHUTDOWN_TIMEOUT_MS`. */
  timeoutMs: number;
  /**
   * How long `/ready` answers 503 while the server still serves, before HTTP closes, from
   * `PLUMBUS_SHUTDOWN_DRAIN_DELAY_MS` (default 0). Gives a load balancer time to take the
   * process out of rotation.
   */
  drainDelayMs: number;
}

function readMilliseconds(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > MAX_SHUTDOWN_MS) {
    throw new Error(
      `${name} must be a whole number of milliseconds from ${min} to ${MAX_SHUTDOWN_MS} (received "${raw}")`,
    );
  }
  return value;
}

/** Read and check the shutdown settings; throws on a malformed value so startup fails early. */
export function resolveShutdownSettings(
  env: Record<string, string | undefined> = process.env,
): ShutdownSettings {
  const timeoutMs = readMilliseconds(
    env,
    'PLUMBUS_SHUTDOWN_TIMEOUT_MS',
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    1000,
  );
  const drainDelayMs = readMilliseconds(env, 'PLUMBUS_SHUTDOWN_DRAIN_DELAY_MS', 0, 0);
  if (drainDelayMs >= timeoutMs) {
    throw new Error(
      `PLUMBUS_SHUTDOWN_DRAIN_DELAY_MS (${drainDelayMs}) must be less than PLUMBUS_SHUTDOWN_TIMEOUT_MS (${timeoutMs})`,
    );
  }
  return { timeoutMs, drainDelayMs };
}

/** A shutdown's deadline, and the slice of it kept back for closing queues and the database. */
export interface ShutdownBudget extends ShutdownContext {
  /** Deadline for draining work (HTTP, workers, the host hook): `deadlineAt` minus the reserve. */
  drainDeadlineAt: number;
}

export function createShutdownBudget(
  timeoutMs: number,
  signal?: string,
  now: () => number = Date.now,
): ShutdownBudget {
  const deadlineAt = now() + timeoutMs;
  // Closing queues and the pool takes the last slice; draining never eats into it.
  const reserveMs = Math.min(2000, Math.floor(timeoutMs / 5));
  return {
    ...(signal ? { signal } : {}),
    deadlineAt,
    drainDeadlineAt: deadlineAt - reserveMs,
    remainingMs: () => Math.max(0, deadlineAt - now()),
  };
}

/**
 * Wait for `work` until `deadlineAt`. Resolves true when it settled in time (a rejection is
 * reported through `onError`, not thrown), false when the deadline came first; the work itself
 * is left running.
 */
export async function settleBy(
  work: Promise<unknown> | (() => Promise<unknown> | unknown),
  deadlineAt: number,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = (async () => {
    try {
      await (typeof work === 'function' ? work() : work);
    } catch (error) {
      onError?.(error);
    }
    return true;
  })();
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Sleep `ms`, cut short at `deadlineAt`. */
export function sleepUntil(ms: number, deadlineAt: number): Promise<void> {
  const wait = Math.max(0, Math.min(ms, deadlineAt - Date.now()));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, wait);
    timer.unref?.();
  });
}

/** The pieces of one process a shutdown closes, in the order it closes them. */
export interface GracefulShutdownPlan {
  settings: ShutdownSettings;
  signal?: string;
  log: { info(message: string): void; error(message: string): void };
  /** 1. `/ready` answers 503 from now on. */
  markNotReady?: () => void;
  /** 2. Stop accepting connections and wait for in-flight requests (Fastify `close`). */
  closeHttp?: () => Promise<void>;
  /** Cuts connections still open when `closeHttp` misses the drain deadline. */
  forceCloseHttp?: () => void;
  /**
   * 3. Stop claiming; running steps get until `deadlineAt`. Resolve `false` when a step was
   * still running at the deadline and was abandoned.
   */
  stopWorkers?: (deadlineAt: number) => Promise<boolean | undefined>;
  /** 4. Host resources (`export const onShutdown` in `app/server.ts`). */
  onShutdown?: OnShutdownHook;
  /** 5. */
  closeQueues?: () => Promise<void>;
  /** 6. Queries still running get `timeoutSeconds`. */
  closeDatabase?: (timeoutSeconds: number) => Promise<void>;
  /** 7. Last, so a worker's health endpoint answers while it drains. */
  closeHealth?: () => Promise<void>;
  /**
   * Called with 1 when the hard deadline passes first, or when the shutdown finished but left
   * work running (an abandoned step, a hook or close that missed its deadline) that could keep
   * the process alive. Default `process.exit`.
   */
  exit?: (code: number) => void;
}

export interface GracefulShutdownResult {
  /** False when some phase missed its deadline; `exit(1)` was called. */
  clean: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one process's shutdown within `settings.timeoutMs`. Each phase is bounded: draining
 * (the drain delay, HTTP, workers, the host hook) stops at the budget's drain deadline, which
 * keeps the last slice for queues and the database. A phase that misses its deadline leaves
 * work behind that can keep the event loop alive, so the process then exits with code 1 —
 * and in any case at the hard deadline — rather than live on as a headless worker.
 */
export async function runGracefulShutdown(
  plan: GracefulShutdownPlan,
): Promise<GracefulShutdownResult> {
  const { settings, log } = plan;
  const exit = plan.exit ?? ((code: number) => process.exit(code));
  const budget = createShutdownBudget(settings.timeoutMs, plan.signal);
  const hardDeadline = setTimeout(() => {
    log.error(`Graceful shutdown timed out after ${settings.timeoutMs}ms — forcing exit`);
    exit(1);
  }, settings.timeoutMs);
  hardDeadline.unref?.();
  let clean = true;
  const missed = (what: string) => {
    clean = false;
    log.error(`${what} at the shutdown deadline`);
  };

  try {
    plan.markNotReady?.();
    if (plan.closeHttp) {
      if (settings.drainDelayMs > 0) {
        log.info(`Readiness is off; serving for ${settings.drainDelayMs}ms before closing HTTP`);
        await sleepUntil(settings.drainDelayMs, budget.drainDeadlineAt);
      }
      const drained = await settleBy(plan.closeHttp(), budget.drainDeadlineAt, (error) =>
        log.error(`HTTP close failed: ${errorMessage(error)}`),
      );
      if (!drained) {
        // Cutting the connections lets the close finish; nothing is left running.
        log.error('HTTP requests still open at the drain deadline; closing their connections');
        plan.forceCloseHttp?.();
      }
    }
    if (plan.stopWorkers) {
      const stopWorkers = plan.stopWorkers;
      let drained: boolean | undefined;
      const stopped = await settleBy(
        async () => {
          drained = await stopWorkers(budget.drainDeadlineAt);
        },
        budget.drainDeadlineAt,
        (error) => log.error(`Worker pool stop failed: ${errorMessage(error)}`),
      );
      if (!stopped) missed('Worker pool still stopping');
      else if (drained === false) missed('A flow step was still running and was abandoned');
    }
    if (plan.onShutdown) {
      const hook = plan.onShutdown;
      const finished = await settleBy(
        () => hook(budget),
        budget.drainDeadlineAt,
        (error) => log.error(`onShutdown hook failed: ${errorMessage(error)}`),
      );
      if (!finished) missed('onShutdown hook still running');
    }
    if (plan.closeQueues) {
      const closed = await settleBy(plan.closeQueues(), budget.deadlineAt, (error) =>
        log.error(`Queue close failed: ${errorMessage(error)}`),
      );
      if (!closed) missed('Queues still closing');
    }
    if (plan.closeDatabase) {
      const seconds = Math.max(0, Math.floor(budget.remainingMs() / 1000) - 1);
      const closed = await settleBy(plan.closeDatabase(seconds), budget.deadlineAt, (error) =>
        log.error(`Database close failed: ${errorMessage(error)}`),
      );
      if (!closed) missed('Database pool still closing');
    }
    if (plan.closeHealth) {
      const closed = await settleBy(plan.closeHealth(), budget.deadlineAt);
      if (!closed) missed('Health server still closing');
    }
  } finally {
    clearTimeout(hardDeadline);
  }
  if (!clean) exit(1);
  return { clean };
}
