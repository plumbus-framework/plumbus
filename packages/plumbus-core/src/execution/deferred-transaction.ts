// ── Deferred transaction ──
// A database transaction that is opened on demand and finished from outside the callback
// that `db.transaction` runs: the callback holds the transaction open until `commit()` or
// `rollback()` is called. This lets a capability's transaction begin at its first write
// instead of before its handler, and bounds the wait for the pool connection BEGIN needs.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DataInternalError, DataPoolAcquireTimeoutError } from '../errors/index.js';

/** Given to the transaction callback when it must roll back. */
class RollbackSignal extends Error {
  constructor() {
    super('capability transaction rolled back');
    this.name = 'RollbackSignal';
  }
}

export interface DeferredTransaction {
  /** Open the transaction (once; later calls share the first) and return its handle. */
  open(): Promise<PostgresJsDatabase>;
  /** Whether `open()` was called and not given up. */
  started(): boolean;
  /** Commit what was opened; no-op when nothing was. Throws a failed open or COMMIT. */
  commit(): Promise<void>;
  /** Roll back what was opened, or give up an open still waiting for a connection. Never throws. */
  rollback(): Promise<void>;
}

/**
 * @param acquireTimeoutMs Longest wait for a pool connection to run BEGIN. Past it `open()`
 *   rejects with `DataPoolAcquireTimeoutError`; when the connection arrives later the
 *   transaction is rolled back at once and the connection returned. `0`/absent: no limit.
 */
export function createDeferredTransaction(
  db: PostgresJsDatabase,
  acquireTimeoutMs?: number,
): DeferredTransaction {
  let opening: Promise<PostgresJsDatabase> | undefined;
  let handle: PostgresJsDatabase | undefined;
  let settled: Promise<unknown> | undefined;
  let finish: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  /** BEGIN has not run yet and nobody wants it any more (timed out, or rolled back). */
  let abandoned = false;

  function open(): Promise<PostgresJsDatabase> {
    if (opening) return opening;
    opening = new Promise<PostgresJsDatabase>((resolveOpen, rejectOpen) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (acquireTimeoutMs !== undefined && acquireTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (handle) return;
          abandoned = true;
          rejectOpen(
            new DataPoolAcquireTimeoutError(
              `No database connection became free within ${acquireTimeoutMs} ms to open the capability's transaction`,
              { timeoutMs: acquireTimeoutMs },
            ),
          );
        }, acquireTimeoutMs);
        timer.unref?.();
      }
      const done = new Promise<void>((resolve, reject) => {
        finish = { resolve, reject };
      });
      // Rejected on rollback; awaited inside the callback when the transaction opened.
      done.catch(() => undefined);
      settled = db.transaction(async (tx) => {
        if (timer) clearTimeout(timer);
        if (abandoned) {
          throw new DataInternalError('transaction given up before its connection was free');
        }
        handle = tx;
        resolveOpen(tx);
        await done;
      });
      settled.catch((error: unknown) => {
        if (timer) clearTimeout(timer);
        // Rejects an open still pending (BEGIN failed, or the abandoned callback); a no-op
        // once the open resolved or timed out.
        rejectOpen(error);
      });
    });
    // A failed open is the caller's to see through the promise it awaited.
    opening.catch(() => undefined);
    return opening;
  }

  return {
    open,
    started: () => opening !== undefined && !abandoned,
    async commit() {
      if (!opening) return;
      await opening;
      finish?.resolve();
      await settled;
    },
    async rollback() {
      if (!opening) return;
      if (!handle) {
        // Still waiting for a connection (or the open failed): when BEGIN runs it is
        // rolled back at once. Nothing was written, so there is nothing to wait for.
        abandoned = true;
        return;
      }
      finish?.reject(new RollbackSignal());
      try {
        await settled;
      } catch {
        // Rolled back: the rejection is the signal itself, or the error that aborted it.
      }
    },
  };
}
