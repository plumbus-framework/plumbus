import { and, eq, lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditService } from '../types/audit.js';
import type { LoggerService } from '../types/context.js';
import type { EventEnvelope } from '../types/event.js';
import { deadLetterTable, outboxTable } from './outbox.js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import { recordPipelineAudit } from './pipeline-audit.js';
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
   * How long a claimed (`processing`) row may stay unpublished before a later
   * poll returns it to `pending` (default: 300000). Covers a dispatcher that
   * stopped between claim and publish.
   */
  claimTimeoutMs?: number;
  /** Receives audit write and poll failures (default: console) */
  logger?: LoggerService;
}

/**
 * Creates a dispatcher that polls the outbox table for pending events,
 * publishes them to the queue, and marks them as dispatched.
 * Returns start/stop controls.
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
    claimTimeoutMs = 300_000,
    metrics,
    audit,
    logger,
  } = config;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let polling = false;

  /** Compute exponential backoff delay: min(base * 2^attempt, max) */
  function computeBackoff(attempt: number): number {
    return Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs);
  }

  async function poll(): Promise<number> {
    if (polling) return 0;
    polling = true;

    try {
      const now = new Date();

      // Release claims whose dispatcher stopped before publishing
      await db
        .update(outboxTable)
        .set({ status: 'pending' })
        .where(
          and(
            eq(outboxTable.status, 'processing'),
            lt(outboxTable.dispatchedAt, new Date(now.getTime() - claimTimeoutMs)),
          ),
        );

      // Fetch pending rows and failed rows whose backoff has elapsed
      const rows = await db
        .select()
        .from(outboxTable)
        .where(eq(outboxTable.status, 'pending'))
        .limit(batchSize)
        .orderBy(outboxTable.occurredAt);

      // Also retry failed rows that have waited long enough
      const failedRows = await db
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
        const claimed = await db
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

        // No outcome yet: audit outcomes are `success | failure | denied`
        await recordPipelineAudit(audit, logger, 'event.dispatch.attempt', {
          eventId: row.id,
          eventType: row.eventType,
          tenantId: row.tenantId,
        });

        try {
          await queue.publish(envelope);
          await db
            .update(outboxTable)
            .set({ status: 'dispatched', dispatchedAt: new Date() })
            .where(eq(outboxTable.id, row.id));
          dispatched++;
          metrics?.eventEmitted.inc({ eventType: row.eventType });
          await recordPipelineAudit(audit, logger, 'event.dispatch.dispatched', {
            eventId: row.id,
            eventType: row.eventType,
            tenantId: row.tenantId,
            outcome: 'success',
          });
        } catch (err) {
          const retryCount = parseInt(row.retryCount, 10) + 1;
          const errorMsg = err instanceof Error ? err.message : String(err);

          await recordPipelineAudit(audit, logger, 'event.dispatch.failed', {
            eventId: row.id,
            eventType: row.eventType,
            tenantId: row.tenantId,
            retryCount,
            error: errorMsg,
            outcome: 'failure',
            disposition: retryCount >= maxRetries ? 'dead_lettered' : 'retry',
          });

          if (retryCount >= maxRetries) {
            // Move to dead-letter
            await db.insert(deadLetterTable).values({
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
            await db
              .update(outboxTable)
              .set({ status: 'dead_lettered', retryCount: String(retryCount), lastError: errorMsg })
              .where(eq(outboxTable.id, row.id));
          } else {
            // Mark for retry with backoff
            await db
              .update(outboxTable)
              .set({
                status: 'retry',
                retryCount: String(retryCount),
                lastError: errorMsg,
                dispatchedAt: new Date(), // used as last attempt timestamp for backoff
              })
              .where(eq(outboxTable.id, row.id));
          }
        }
      }
      return dispatched;
    } finally {
      polling = false;
    }
  }

  /** Timer-driven poll; a failed cycle is logged and the next tick retries */
  function tick(): void {
    poll().catch((err) => {
      const details = { error: err instanceof Error ? err.message : String(err) };
      if (logger) logger.error('Outbox poll failed', details);
      else console.error('[plumbus] outbox poll failed', details);
    });
  }

  return {
    /** Run a single poll cycle (useful for testing) */
    poll,

    /** Start the background polling loop */
    start(): void {
      if (running) return;
      running = true;
      timer = setInterval(tick, pollIntervalMs);
      tick();
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
