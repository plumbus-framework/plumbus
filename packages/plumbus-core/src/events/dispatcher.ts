import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import type { AuditService } from '../types/audit.js';
import type { EventEnvelope } from '../types/event.js';
import { deadLetterTable, outboxTable } from './outbox.js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import type { EventQueue } from './queue.js';

export interface DispatcherConfig {
  db: PostgresJsDatabase;
  queue: EventQueue;
  audit?: AuditService;
  metrics?: PlumbusMetrics;
  /** Poll interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;
  /** Max rows to fetch per poll (default: 100) */
  batchSize?: number;
  /** Max retries before moving to dead-letter (default: 5) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  backoffBaseMs?: number;
  /** Max backoff delay in ms (default: 60000) */
  backoffMaxMs?: number;
  /**
   * When set with `listTenantRefs`, each poll resolves those tenants and
   * drains `event_outbox` (and `dispatch_outbox` when `spineDb` is set) on
   * that tenant's database. The pool `db` is not polled in this mode —
   * it is the spine / control plane, not a tenant outbox.
   */
  resolver?: DataPlaneResolver;
  /** Tenant references to pump this cycle. Required for the per-tenant path. */
  listTenantRefs?: () => Iterable<string> | Promise<Iterable<string>>;
  /**
   * Spine database for Protocol A `dispatch_outbox` publication. Omitted,
   * the dispatcher only drains `event_outbox` (historical behavior).
   */
  spineDb?: PostgresJsDatabase;
}

interface PumpTarget {
  db: PostgresJsDatabase;
  tenantRef: string;
  coreSchema: string;
}

/**
 * Creates a dispatcher that polls the outbox table for pending events,
 * publishes them to the queue, and marks them as dispatched.
 * Returns start/stop controls.
 *
 * With `resolver` + `listTenantRefs` this is the same pump, pointed at each
 * tenant database in turn. `dispatch_outbox` is drained on the same cycle
 * when `spineDb` is set — not a second bus.
 */
export function createOutboxDispatcher(config: DispatcherConfig) {
  const {
    db,
    queue,
    pollIntervalMs = 1000,
    batchSize = 100,
    maxRetries = 5,
    backoffBaseMs = 1000,
    backoffMaxMs = 60_000,
    metrics,
    audit,
    resolver,
    listTenantRefs,
    spineDb,
  } = config;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let polling = false;

  /** Compute exponential backoff delay: min(base * 2^attempt, max) */
  function computeBackoff(attempt: number): number {
    return Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs);
  }

  async function resolveTargets(): Promise<PumpTarget[]> {
    if (!resolver || !listTenantRefs) {
      return [{ db, tenantRef: 'default', coreSchema: 'public' }];
    }
    const refs = [...(await listTenantRefs())];
    const targets: PumpTarget[] = [];
    for (const tenantRef of refs) {
      const handle = await resolver.resolve(tenantRef);
      targets.push({
        db: handle.db,
        tenantRef: handle.tenantRef,
        coreSchema: handle.coreSchema,
      });
    }
    return targets;
  }

  async function pollEventOutbox(targetDb: PostgresJsDatabase): Promise<number> {
    const now = new Date();
    const rows = await targetDb
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.status, 'pending'))
      .limit(batchSize)
      .orderBy(outboxTable.occurredAt);

    const failedRows = await targetDb
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.status, 'retry'))
      .limit(batchSize)
      .orderBy(outboxTable.occurredAt);

    const allRows = [
      ...rows,
      ...failedRows.filter((r) => {
        const retryCount = parseInt(r.retryCount, 10);
        if (retryCount >= maxRetries) return false;
        const backoffMs = computeBackoff(retryCount);
        const lastAttempt = r.dispatchedAt ?? r.occurredAt;
        return now.getTime() - lastAttempt.getTime() >= backoffMs;
      }),
    ];

    let dispatched = 0;
    const pendingCount = rows.length + failedRows.length;
    metrics?.outboxPending.set(pendingCount);

    for (const row of allRows) {
      const claimed = await targetDb
        .update(outboxTable)
        .set({
          status: 'processing',
          dispatchedAt: new Date(),
        })
        .where(and(eq(outboxTable.id, row.id), eq(outboxTable.status, row.status)))
        .returning({ id: outboxTable.id });
      if (claimed.length === 0) continue;

      const envelope: EventEnvelope = {
        id: row.id,
        eventType: row.eventType,
        version: row.version,
        occurredAt: row.occurredAt,
        actor: row.actor,
        tenantId: row.tenantId ?? undefined,
        correlationId: row.correlationId,
        causationId: row.causationId ?? undefined,
        payload: row.payload as Record<string, unknown>,
      };

      try {
        await audit?.record('event.dispatch.attempt', {
          eventId: row.id,
          eventType: row.eventType,
          tenantId: row.tenantId,
          outcome: 'pending',
        });
        await queue.publish(envelope);
        await targetDb
          .update(outboxTable)
          .set({ status: 'dispatched', dispatchedAt: new Date() })
          .where(eq(outboxTable.id, row.id));
        dispatched++;
        metrics?.eventEmitted.inc({ eventType: row.eventType });
        await audit?.record('event.dispatch.dispatched', {
          eventId: row.id,
          eventType: row.eventType,
          tenantId: row.tenantId,
          outcome: 'success',
        });
      } catch (err) {
        const retryCount = parseInt(row.retryCount, 10) + 1;
        const errorMsg = err instanceof Error ? err.message : String(err);

        await audit?.record('event.dispatch.failed', {
          eventId: row.id,
          eventType: row.eventType,
          tenantId: row.tenantId,
          retryCount,
          error: errorMsg,
          outcome: retryCount >= maxRetries ? 'dead_lettered' : 'retry',
        });

        if (retryCount >= maxRetries) {
          await targetDb.insert(deadLetterTable).values({
            eventId: row.id,
            eventType: row.eventType,
            payload: row.payload as any,
            consumerId: null,
            lastError: errorMsg,
            retryCount: String(retryCount),
            metadata: {
              correlationId: row.correlationId,
              causationId: row.causationId,
              actor: row.actor,
              tenantId: row.tenantId,
            },
          });
          await targetDb
            .update(outboxTable)
            .set({ status: 'dead_lettered', retryCount: String(retryCount), lastError: errorMsg })
            .where(eq(outboxTable.id, row.id));
        } else {
          await targetDb
            .update(outboxTable)
            .set({
              status: 'retry',
              retryCount: String(retryCount),
              lastError: errorMsg,
              dispatchedAt: new Date(),
            })
            .where(eq(outboxTable.id, row.id));
        }
      }
    }
    return dispatched;
  }

  async function pumpDispatchOutbox(target: PumpTarget): Promise<number> {
    if (!spineDb) return 0;
    const { listUnpublishedOutbox, publishOutboxToSpine } = await import(
      '../durable/postgres-persist.js'
    );
    const unpublished = await listUnpublishedOutbox(target.db, target.coreSchema);
    let published = 0;
    for (const row of unpublished) {
      try {
        const dispatchId = row.spineRowId ?? `disp:${row.executionId}:${row.expectedRevision}`;
        await publishOutboxToSpine(
          target.db,
          spineDb,
          row,
          dispatchId,
          new Date().toISOString(),
          target.coreSchema,
        );
        published += 1;
      } catch (err) {
        console.error('[plumbus] dispatch_outbox pump failed', {
          tenantRef: target.tenantRef,
          outboxId: row.outboxId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return published;
  }

  async function poll(): Promise<number> {
    if (polling) return 0;
    polling = true;

    try {
      const targets = await resolveTargets();
      let dispatched = 0;
      for (const target of targets) {
        dispatched += await pollEventOutbox(target.db);
        dispatched += await pumpDispatchOutbox(target);
      }
      return dispatched;
    } finally {
      polling = false;
    }
  }

  return {
    /** Run a single poll cycle (useful for testing) */
    poll,

    /** Start the background polling loop */
    start(): void {
      if (running) return;
      running = true;
      timer = setInterval(() => {
        void poll();
      }, pollIntervalMs);
      void poll();
    },

    /** Stop the background polling loop */
    stop(): void {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    get isRunning(): boolean {
      return running;
    },
  };
}
