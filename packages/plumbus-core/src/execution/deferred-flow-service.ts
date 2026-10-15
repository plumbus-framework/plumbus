import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  deleteFlowStartIntent,
  flowStartIntentsAvailable,
  writeFlowStartIntent,
} from '../flows/start-intents.js';
import type { FlowService } from '../types/context.js';
import type { AuthContext } from '../types/security.js';

/**
 * Where a deferred start persists its intent: the open transaction, the database it runs on
 * (for the post-commit cleanup), and the identity the start runs with.
 */
export interface DurableFlowStartTarget {
  tx: PostgresJsDatabase;
  planeDb: PostgresJsDatabase;
  auth: AuthContext;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

/**
 * Wraps a FlowService so `start` runs after the active transaction commits.
 * Returns a pre-allocated execution id immediately so handlers can await without deadlocking the tx.
 * `status`/`resume`/`cancel` for ids still pending commit return a pending handle (or no-op)
 * so callers do not hit not-found before the post-commit start runs.
 *
 * With `durable`, the start is also written to `flow_start_intents` inside the transaction, so
 * a process that dies between commit and start leaves an intent a worker starts later under
 * the same execution id. A database without that table (not yet migrated) keeps the
 * post-commit start alone.
 */
export function createDeferredFlowService(
  flows: FlowService,
  deferred: Array<() => Promise<void>>,
  allocExecutionId: () => string = () => crypto.randomUUID(),
  durable?: DurableFlowStartTarget,
): FlowService {
  const pending = new Map<string, { flowName: string }>();
  let warnedUnmigrated = false;

  return {
    async start(flowName, input, opts) {
      const executionId = opts?.executionId ?? allocExecutionId();
      let persisted = false;
      if (durable) {
        if (await flowStartIntentsAvailable(durable.planeDb, durable.tx)) {
          await writeFlowStartIntent(durable.tx, {
            executionId,
            flowName,
            input,
            auth: durable.auth,
          });
          persisted = true;
        } else if (!warnedUnmigrated) {
          warnedUnmigrated = true;
          durable.logger?.warn(
            'flow_start_intents is missing; a flow start deferred to commit is lost if the process stops first. Run plumbus migrate generate and apply.',
          );
        }
      }
      pending.set(executionId, { flowName });
      deferred.push(async () => {
        try {
          await flows.start(flowName, input, { executionId });
        } finally {
          pending.delete(executionId);
        }
        // Started (or found already started): the intent is done. A failed start throws
        // above and leaves the intent for a worker to retry.
        if (persisted && durable) await deleteFlowStartIntent(durable.planeDb, executionId);
      });
      return {
        id: executionId,
        flowName,
        status: 'pending',
      };
    },
    async resume(executionId, signal) {
      if (pending.has(executionId)) {
        return;
      }
      return flows.resume(executionId, signal);
    },
    async cancel(executionId) {
      if (pending.has(executionId)) {
        pending.delete(executionId);
        return;
      }
      return flows.cancel(executionId);
    },
    async terminate(executionId) {
      if (pending.has(executionId)) {
        pending.delete(executionId);
        return;
      }
      return flows.terminate(executionId);
    },
    async status(executionId) {
      const pendingMeta = pending.get(executionId);
      if (pendingMeta) {
        return {
          id: executionId,
          flowName: pendingMeta.flowName,
          status: 'pending',
        };
      }
      return flows.status(executionId);
    },
    heartbeat: () => flows.heartbeat(),
  };
}
