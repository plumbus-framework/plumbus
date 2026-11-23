import { and, eq, lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { FRAMEWORK_SCHEMA, resolveFrameworkSchema } from '../data/schema-generator.js';
import { PlumbusError } from '../errors/plumbus-error.js';
import { validatedTraceparent } from '../observability/index.js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import { withDataPlane } from '../tenancy/data-plane-resolver.js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import type { AuditService } from '../types/audit.js';
import { ErrorCode } from '../types/enums.js';
import type { LoggerService } from '../types/context.js';
import type { EventEnvelope } from '../types/event.js';
import { deadLetterTable, outboxTable } from './outbox.js';
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
  /**
   * When set with `listTenantRefs`, each poll visits those tenants one at a time: it takes
   * the tenant's plane (a lease when the resolver supports one), drains `event_outbox` (and
   * `dispatch_outbox` when `spineDb` is set) on it, and gives it back before taking the next
   * one, so a poll holds at most one plane. A tenant that cannot be resolved is logged and
   * skipped; the others are still pumped. The pool `db` is not polled in this mode — it is
   * the spine / control plane, not a tenant outbox.
   */
  resolver?: DataPlaneResolver;
  /**
   * Back off tenant planes that had nothing to dispatch: after an idle visit a plane is
   * skipped for twice as long as the time before (starting from `pollIntervalMs`), up to
   * this many milliseconds, and visited every poll again as soon as a visit finds work (or
   * `wake(tenantRef)` is called). Default `0`: every plane is visited every poll. An event
   * written to an idle plane waits at most this long before it is dispatched. Only the
   * per-tenant path backs off; the single-database pump polls every interval.
   */
  idlePlaneBackoffMaxMs?: number;
  /** Tenant references to pump this cycle. Required for the per-tenant path. */
  listTenantRefs?: () => Iterable<string> | Promise<Iterable<string>>;
  /**
   * Spine database for Protocol A `dispatch_outbox` publication. Omitted,
   * the dispatcher only drains `event_outbox` (historical behavior).
   */
  spineDb?: PostgresJsDatabase;
  /**
   * The schema every plane's durable `dispatch_outbox` lives in — the same one the flow
   * engine writes it under (`spineDispatch.coreSchema`, else `PLUMBUS_FRAMEWORK_SCHEMA`,
   * else the framework default). Defaults the same way, so a host that configures nothing
   * reads where it wrote. This is deliberately *not* the plane handle's `coreSchema`: that
   * names the tenant's own entity tables, which a host may keep in `public` while the
   * durable tables sit in the framework schema — reading `dispatch_outbox` from the
   * handle's schema answered `relation "dispatch_outbox" does not exist` for every tenant
   * on every poll.
   */
  frameworkSchema?: string;
  /**
   * Whether this dispatcher publishes a plane's `event_outbox` rows (core 0.9.0-beta.15).
   * Default `true`. `false`, or a function answering `false` for a plane, leaves that plane's
   * `event_outbox` to a host that relays it itself; `dispatch_outbox` (flow dispatch hints) is
   * still pumped. The function gets the tenant reference, or `undefined` for the pool's own
   * database (the single-database pump).
   */
  pumpEventOutbox?: boolean | ((tenantRef: string | undefined) => boolean);
}

interface PumpTarget {
  db: PostgresJsDatabase;
  tenantRef: string;
  /** Whether to pump the plane's `event_outbox` (see `DispatcherConfig.pumpEventOutbox`). */
  events: boolean;
}

/** What one visit to a plane found: rows dispatched or published, and rows still waiting. */
interface PumpResult {
  dispatched: number;
  /** Rows seen in `pending` / `retry` (dispatched or not) plus rows published to the spine. */
  activity: number;
}

/** When an idle plane is due again. */
interface IdleState {
  /** Consecutive idle visits. */
  idleVisits: number;
  nextVisitAt: number;
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
    claimTimeoutMs = 300_000,
    metrics,
    audit,
    logger,
    resolver,
    listTenantRefs,
    spineDb,
    idlePlaneBackoffMaxMs = 0,
  } = config;
  if (!Number.isSafeInteger(idlePlaneBackoffMaxMs) || idlePlaneBackoffMaxMs < 0) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `idlePlaneBackoffMaxMs must be a whole number of milliseconds, 0 or more (received ${String(idlePlaneBackoffMaxMs)})`,
    );
  }
  /** Idle tenant planes and when each is due again; absent means due now. */
  const idlePlanes = new Map<string, IdleState>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let polling = false;

  /** Compute exponential backoff delay: min(base * 2^attempt, max) */
  function computeBackoff(attempt: number): number {
    return Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs);
  }

  /** Logger messages are sentence case; the console fallback keeps the `[plumbus]` prefix. */
  function logError(message: string, details: Record<string, unknown>): void {
    if (logger) logger.error(message, details);
    else console.error(`[plumbus] ${message.charAt(0).toLowerCase()}${message.slice(1)}`, details);
  }

  // Where `dispatch_outbox` is, on every plane: the engine's own resolution, mirrored.
  const durableSchema = config.frameworkSchema ?? resolveFrameworkSchema() ?? FRAMEWORK_SCHEMA;

  function isDue(tenantRef: string, at: number): boolean {
    const idle = idlePlanes.get(tenantRef);
    return idle === undefined || at >= idle.nextVisitAt;
  }

  function recordVisit(tenantRef: string, result: PumpResult, at: number): void {
    if (idlePlaneBackoffMaxMs === 0 || result.activity > 0) {
      idlePlanes.delete(tenantRef);
      return;
    }
    const idleVisits = (idlePlanes.get(tenantRef)?.idleVisits ?? 0) + 1;
    const skipFor = Math.min(pollIntervalMs * 2 ** (idleVisits - 1), idlePlaneBackoffMaxMs);
    idlePlanes.set(tenantRef, { idleVisits, nextVisitAt: at + skipFor });
  }

  /** Whether a plane's `event_outbox` is this dispatcher's to pump. */
  function pumpsEvents(tenantRef: string | undefined): boolean {
    const choice = config.pumpEventOutbox ?? true;
    return typeof choice === 'function' ? choice(tenantRef) : choice;
  }

  /** Drain one plane: `event_outbox`, then `dispatch_outbox` when a spine is configured. */
  async function pumpPlane(target: PumpTarget): Promise<PumpResult> {
    const events = target.events ? await pollEventOutbox(target.db) : { dispatched: 0, seen: 0 };
    const published = await pumpDispatchOutbox(target);
    return {
      dispatched: events.dispatched + published,
      activity: events.seen + published,
    };
  }

  /**
   * The per-tenant pump: list the tenants, then for each due one hold its plane only while
   * draining it. A tenant that fails to resolve or to drain is logged and skipped.
   */
  async function pollTenantPlanes(
    planeResolver: DataPlaneResolver,
    list: NonNullable<DispatcherConfig['listTenantRefs']>,
  ): Promise<number> {
    let refs: string[];
    try {
      refs = [...(await list())];
    } catch (err) {
      logError('Outbox poll could not list its tenant planes', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
    const listed = new Set(refs);
    for (const tenantRef of idlePlanes.keys()) {
      if (!listed.has(tenantRef)) idlePlanes.delete(tenantRef);
    }
    let dispatched = 0;
    for (const tenantRef of refs) {
      const at = Date.now();
      if (!isDue(tenantRef, at)) continue;
      const events = pumpsEvents(tenantRef);
      // Nothing of this plane's is ours to pump: do not even take it.
      if (!events && !spineDb) continue;
      // One plane's failure must neither stop the others nor escape the timer: an
      // unhandled rejection here would take the worker process down.
      try {
        const result = await withDataPlane(
          planeResolver,
          tenantRef,
          (handle) => pumpPlane({ db: handle.db, tenantRef: handle.tenantRef, events }),
          { purpose: 'background' },
        );
        dispatched += result.dispatched;
        recordVisit(tenantRef, result, at);
      } catch (err) {
        logError('Outbox poll failed for one plane', {
          tenantRef,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return dispatched;
  }

  async function pollEventOutbox(
    targetDb: PostgresJsDatabase,
  ): Promise<{ dispatched: number; seen: number }> {
    const now = new Date();

    // Release claims whose dispatcher stopped before publishing
    await targetDb
      .update(outboxTable)
      .set({ status: 'pending' })
      .where(
        and(
          eq(outboxTable.status, 'processing'),
          lt(outboxTable.dispatchedAt, new Date(now.getTime() - claimTimeoutMs)),
        ),
      );

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
        traceparent: validatedTraceparent(row.traceparent),
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
        await targetDb
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
          await targetDb.insert(deadLetterTable).values({
            eventId: row.id,
            eventType: row.eventType,
            payload: row.payload as any,
            consumerId: null,
            lastError: errorMsg,
            retryCount: String(retryCount),
            metadata: {
              traceparent: validatedTraceparent(row.traceparent),
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
    return { dispatched, seen: pendingCount };
  }

  async function pumpDispatchOutbox(target: PumpTarget): Promise<number> {
    if (!spineDb) return 0;
    const { claimUnpublishedOutbox, publishOutboxToSpine } = await import(
      '../durable/postgres-persist.js'
    );
    // Rows are locked while they are published (SKIP LOCKED), so concurrent pumps split them;
    // the guarded spine upsert keeps any hint a worker already leased.
    let published = 0;
    await claimUnpublishedOutbox(
      target.db,
      async (tx, row) => {
        const dispatchId = row.spineRowId ?? `disp:${row.executionId}:${row.expectedRevision}`;
        try {
          await publishOutboxToSpine(
            tx,
            spineDb,
            row,
            dispatchId,
            new Date().toISOString(),
            durableSchema,
          );
          published += 1;
        } catch (err) {
          logError('dispatch_outbox pump failed', {
            tenantRef: target.tenantRef,
            outboxId: row.outboxId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      { schemaName: durableSchema },
    );
    return published;
  }

  async function poll(): Promise<number> {
    if (polling) return 0;
    polling = true;

    try {
      if (resolver && listTenantRefs) return await pollTenantPlanes(resolver, listTenantRefs);
      const events = pumpsEvents(undefined);
      if (!events && !spineDb) return 0;
      try {
        return (await pumpPlane({ db, tenantRef: 'default', events })).dispatched;
      } catch (err) {
        logError('Outbox poll failed for one plane', {
          tenantRef: 'default',
          error: err instanceof Error ? err.message : String(err),
        });
        return 0;
      }
    } finally {
      polling = false;
    }
  }

  /** Timer-driven poll; a failed cycle is logged and the next tick retries */
  function tick(): void {
    poll().catch((err) => {
      logError('Outbox poll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    /** Run a single poll cycle (useful for testing) */
    poll,

    /**
     * Visit `tenantRef`'s plane (every plane when omitted) on the next poll even if it is
     * backing off as idle. A host that knows it just wrote to a plane's outbox can call it.
     */
    wake(tenantRef?: string): void {
      if (tenantRef === undefined) idlePlanes.clear();
      else idlePlanes.delete(tenantRef);
    },

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
