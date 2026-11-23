// ── Data-plane connection budget ──
// One ceiling on server connections across every pool a pooled resolver opens
// (`maxTotalConnections`). `cacheSize` bounds how many planes are open; this bounds how many
// connections they hold together, so a host with many tenants on one small database server can
// keep a cache as large as its fleet without multiplying the per-plane pool size past what the
// server allows.
//
// Every connection a budgeted pool opens takes a slot before its socket is opened and gives it
// back when the socket closes (idle timeout, lifetime, pool close). With no free slot it first
// asks the resolver to close the least recently used plane nobody holds a lease on (its pool's
// connections then free their slots), then waits a bounded time and refuses with
// `DataPlaneConnectionBudgetError`. A leased plane's connections are never taken away.

import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';

/**
 * No server connection was free under `maxTotalConnections` within the wait. Nothing was opened.
 * Served as HTTP 503 on the request path (it reaches the caller as the failure of the query
 * that needed the connection); background loops retry on their next cycle.
 */
export class DataPlaneConnectionBudgetError extends PlumbusError {
  constructor(
    tenantRef: string,
    metadata: { maxTotalConnections: number; open: number; waitedMs: number },
  ) {
    super(
      ErrorCode.Conflict,
      `No database connection free for tenant reference "${tenantRef}": all ` +
        `${metadata.maxTotalConnections} connections of the data-plane budget are open and none ` +
        `closed within ${metadata.waitedMs} ms`,
      { tenantRef, ...metadata, reason: 'data-plane-connection-budget', httpStatus: 503 },
    );
    this.name = 'DataPlaneConnectionBudgetError';
  }
}

/**
 * One tenant's view of the shared budget, handed to `connect` (`request.connectionBudget`) and
 * from there to `openDataPlaneConnection({ connectionBudget })`.
 */
export interface DataPlaneConnectionBudget {
  /** The shared ceiling (`maxTotalConnections`). */
  readonly maxConnections: number;
  /** The tenant this view was made for (named in refusals). */
  readonly tenantRef: string;
  /**
   * Take one connection slot, waiting (bounded) for one to free; resolves to the function that
   * gives it back (idempotent). Throws `DataPlaneConnectionBudgetError` past the wait.
   */
  acquire(options?: { signal?: AbortSignal }): Promise<() => void>;
}

/** What the shared budget holds right now. */
export interface DataPlaneConnectionBudgetStats {
  max: number;
  open: number;
  waiting: number;
}

export interface SharedConnectionBudget {
  forTenant(tenantRef: string): DataPlaneConnectionBudget;
  stats(): DataPlaneConnectionBudgetStats;
  /** Wake every waiter (the resolver closed; they re-check and fail). */
  wakeAll(): void;
}

export interface SharedConnectionBudgetOptions {
  max: number;
  waitMs: number;
  /**
   * Called when no slot is free: close one unleased plane other than `tenantRef`'s. Resolves
   * `true` when it closed one (its connections free their slots as they close).
   */
  reclaim?: (tenantRef: string) => Promise<boolean>;
  /** `true` once the resolver closed: waiting stops. */
  isClosed?: () => boolean;
  now?: () => number;
}

export function createSharedConnectionBudget(
  options: SharedConnectionBudgetOptions,
): SharedConnectionBudget {
  const now = options.now ?? Date.now;
  let open = 0;
  const waiters = new Set<() => void>();

  function wake(): void {
    for (const resolve of [...waiters]) resolve();
  }

  function waitForSlot(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  function take(): () => void {
    open += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      open -= 1;
      wake();
    };
  }

  async function acquire(tenantRef: string, signal?: AbortSignal): Promise<() => void> {
    const started = now();
    for (;;) {
      if (signal?.aborted) {
        throw new PlumbusError(
          ErrorCode.Cancelled,
          `Waiting for a database connection for tenant reference "${tenantRef}" was aborted`,
          { tenantRef },
        );
      }
      if (open < options.max) return take();
      const closed = options.isClosed?.() === true;
      // No slot: close an idle plane (its connections give their slots back as they close),
      // then wait — bounded — for a slot from it or from any other connection closing.
      if (!closed && options.reclaim) {
        await options.reclaim(tenantRef);
        if (open < options.max) return take();
      }
      const remaining = options.waitMs - (now() - started);
      if (remaining <= 0 || closed) {
        throw new DataPlaneConnectionBudgetError(tenantRef, {
          maxTotalConnections: options.max,
          open,
          waitedMs: now() - started,
        });
      }
      await waitForSlot(remaining, signal);
    }
  }

  return {
    forTenant(tenantRef: string): DataPlaneConnectionBudget {
      return Object.freeze({
        maxConnections: options.max,
        tenantRef,
        acquire: (acquireOptions?: { signal?: AbortSignal }) =>
          acquire(tenantRef, acquireOptions?.signal),
      });
    },
    stats() {
      return { max: options.max, open, waiting: waiters.size };
    },
    wakeAll: wake,
  };
}
