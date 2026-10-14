import { randomUUID } from 'node:crypto';
import {
  resolveRetryPolicy,
  retryDelay,
  isPermanentFailure,
  isDeferredDelivery,
  type RetryPolicy,
} from '../config/index.js';
import { DataValidationError } from '../errors/index.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import type { AuditService } from '../types/audit.js';
import type { LoggerService } from '../types/context.js';
import type { EventEnvelope } from '../types/event.js';
import { createJobService } from '../jobs/service.js';
import type { JobQueuePayload } from '../jobs/types.js';
import type { ConsumerRegistry } from './consumer-registry.js';
import { createIdempotencyService, type IdempotencyService } from './idempotency.js';
import { deadLetterTable } from './outbox.js';
import { recordPipelineAudit } from './pipeline-audit.js';
import type { EventQueue } from './queue.js';
import {
  evaluateEventSubscriptionDelivery,
  resolveConsumerDeliveryPolicy,
} from './subscription.js';

export interface EventDeadLetterInfo {
  deadLetterId: string;
  eventId: string;
  eventType: string;
  consumerId?: string;
  attempts: number;
  reason: 'exhausted' | 'permanent' | 'unrouted';
  tenantId?: string;
}
export interface EventDeliveryOptions {
  retry?: RetryPolicy;
  unrouted?: 'deadLetter' | 'acknowledge';
  ignoredEventTypes?: string[];
}
export interface WorkerConfig extends EventDeliveryOptions {
  onEventDeadLetter?: (info: EventDeadLetterInfo) => void | Promise<void>;
  db: PostgresJsDatabase;
  queue: EventQueue;
  consumers: ConsumerRegistry;
  idempotency: IdempotencyService;
  /**
   * When set, delivery (idempotency + dead-letter + job rows) runs against
   * the tenant data plane resolved from `envelope.tenantId`. The pool `db`
   * and boot-time `idempotency` stay the fallback for untenanted envelopes.
   */
  resolver?: DataPlaneResolver;
  audit?: AuditService;
  metrics?: PlumbusMetrics;
  /** Receives audit write failures (default: console) */
  logger?: LoggerService;
  /** Default max retries per consumer (default: 3) */
  defaultMaxRetries?: number;
  /** Base delay in ms for exponential backoff between retries (default: 100) */
  retryBackoffBaseMs?: number;
  /** Max backoff delay in ms (default: 5000) */
  retryBackoffMaxMs?: number;
}

/**
 * Creates an event delivery worker that subscribes to the queue,
 * routes events to registered consumers with idempotency checks,
 * and dead-letters events that exhaust retries.
 *
 * Returns start/stop controls.
 */
export function createEventWorker(config: WorkerConfig) {
  const {
    db,
    queue,
    consumers,
    idempotency,
    defaultMaxRetries = 3,
    metrics,
    audit,
    logger,
    retryBackoffBaseMs = 100,
    retryBackoffMaxMs = 5000,
    resolver,
  } = config;

  let unsubscribe: (() => void) | null = null;

  if (config.retry?.maxAttempts !== undefined && config.defaultMaxRetries !== undefined)
    throw new DataValidationError('Use retry.maxAttempts or defaultMaxRetries, not both');
  const defaults = resolveRetryPolicy(config.retry, {
    maxAttempts: defaultMaxRetries,
    backoff: 'exponential',
    baseDelayMs: retryBackoffBaseMs,
    maxDelayMs: retryBackoffMaxMs,
  });

  async function planeFor(envelope: EventEnvelope): Promise<{
    db: PostgresJsDatabase;
    idempotency: IdempotencyService;
  }> {
    if (!resolver || !envelope.tenantId) {
      return { db, idempotency };
    }
    const handle = await resolver.resolve(envelope.tenantId);
    return { db: handle.db, idempotency: createIdempotencyService(handle.db) };
  }

  /** Persist a dead letter on `planeDb` (the envelope's data plane), then announce it. */
  async function deadLetter(
    planeDb: PostgresJsDatabase,
    envelope: EventEnvelope,
    consumerId: string | undefined,
    attempts: number,
    reason: EventDeadLetterInfo['reason'],
    lastError: string,
  ): Promise<void> {
    const deadLetterId = randomUUID();
    await planeDb.insert(deadLetterTable).values({
      id: deadLetterId,
      eventId: envelope.id,
      eventType: envelope.eventType,
      payload: envelope.payload as any,
      consumerId,
      lastError,
      retryCount: String(attempts),
      metadata: {
        correlationId: envelope.correlationId,
        causationId: envelope.causationId,
        actor: envelope.actor,
        tenantId: envelope.tenantId,
        reason,
      },
    });
    const info: EventDeadLetterInfo = {
      deadLetterId,
      eventId: envelope.id,
      eventType: envelope.eventType,
      consumerId,
      attempts,
      reason,
      tenantId: envelope.tenantId,
    };
    metrics?.eventFailed.inc({ consumer: consumerId ?? 'unrouted' });
    await recordPipelineAudit(audit, logger, 'event.consumer.dead_lettered', {
      ...info,
      outcome: 'failure',
    });
    (logger ?? console).error('Event delivery dead-lettered', { ...info });
    try {
      await config.onEventDeadLetter?.(info);
    } catch {
      (logger ?? console).error('Event dead-letter notification failed', {
        deadLetterId,
        eventId: envelope.id,
      });
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function deliver(envelope: EventEnvelope): Promise<void> {
    const matched = consumers.getConsumers(envelope.eventType, envelope.version);
    const deliveryStarted = Date.now();

    if (matched.length === 0) {
      metrics?.eventUnrouted?.inc();
      const ignored = config.ignoredEventTypes?.includes(envelope.eventType) === true;
      await recordPipelineAudit(audit, logger, 'event.consumer.unrouted', {
        eventId: envelope.id,
        eventType: envelope.eventType,
        ignored,
        outcome: 'failure',
      });
      (logger ?? console).warn('Event has no matching local consumer', {
        eventId: envelope.id,
        eventType: envelope.eventType,
        ignored,
      });
      if (!ignored && config.unrouted !== 'acknowledge') {
        const plane = await planeFor(envelope);
        await deadLetter(
          plane.db,
          envelope,
          undefined,
          0,
          'unrouted',
          'No matching local consumer',
        );
      }
      return;
    }

    const plane = await planeFor(envelope);
    for (const consumer of matched) {
      // A consumer skipped by subscription policy is not unrouted: no dead letter.
      const policyAllowed = await resolveConsumerDeliveryPolicy(consumer, envelope);
      const subscription = evaluateEventSubscriptionDelivery({
        active: consumer.active,
        policyAllowed,
      });
      if (!subscription.deliver) {
        await recordPipelineAudit(audit, logger, 'event.consumer.skipped', {
          eventId: envelope.id,
          eventType: envelope.eventType,
          consumerId: consumer.id,
          capabilityVersion: consumer.capabilityVersion,
          tenantId: envelope.tenantId,
          reason: subscription.reason,
        });
        continue;
      }

      const policy = resolveRetryPolicy(consumer.retry, {
        ...defaults,
        maxAttempts: consumer.maxRetries ?? defaults.maxAttempts,
      });
      const maxRetries = policy.maxAttempts;

      // Idempotency guard
      const alreadyProcessed = await plane.idempotency.isProcessed(envelope.id, consumer.id);
      if (alreadyProcessed) continue;

      let lastError: string | undefined;
      let attempt = 0;
      let succeeded = false;
      let permanent = false;

      while (attempt < maxRetries && !succeeded) {
        attempt++;
        // No outcome yet: audit outcomes are `success | failure | denied`
        await recordPipelineAudit(audit, logger, 'event.consumer.attempt', {
          eventId: envelope.id,
          eventType: envelope.eventType,
          consumerId: consumer.id,
          attempt,
          tenantId: envelope.tenantId,
        });
        try {
          await consumer.handler(envelope);
          succeeded = true;
        } catch (err) {
          if (isDeferredDelivery(err)) throw err;
          lastError = err instanceof Error ? err.message : String(err);
          permanent = isPermanentFailure(err);
          if (permanent) break;
          if (attempt < maxRetries) await sleep(retryDelay(policy, attempt));
        }
      }

      if (succeeded) {
        await plane.idempotency.markProcessed(envelope.id, consumer.id);
        metrics?.eventDelivered.inc({ consumer: consumer.id });
        metrics?.eventDeliveryDuration.observe(Date.now() - deliveryStarted, {
          consumer: consumer.id,
          outcome: 'delivered',
        });
        await recordPipelineAudit(audit, logger, 'event.consumer.delivered', {
          eventId: envelope.id,
          eventType: envelope.eventType,
          consumerId: consumer.id,
          tenantId: envelope.tenantId,
          outcome: 'success',
        });
      } else {
        await deadLetter(
          plane.db,
          envelope,
          consumer.id,
          attempt,
          permanent ? 'permanent' : 'exhausted',
          lastError ?? 'Unknown error',
        );
        metrics?.eventDeliveryDuration.observe(Date.now() - deliveryStarted, {
          consumer: consumer.id,
          outcome: 'failed',
        });

        if (consumer.id.startsWith('job:')) {
          const payload = envelope.payload as JobQueuePayload;
          if (payload.jobExecutionId) {
            const error = {
              code: 'delivery_exhausted',
              message: lastError ?? 'Job delivery exhausted retries',
            };
            // The envelope's plane first; a tenant job written on the pool (the job consumer
            // reads the pool) is marked there instead.
            const marked = await createJobService(plane.db).markDeadLettered(
              payload.jobExecutionId,
              error,
            );
            if (!marked && plane.db !== db) {
              await createJobService(db).markDeadLettered(payload.jobExecutionId, error);
            }
          }
        }
      }
    }
  }

  return {
    /** Process a single envelope (useful for testing) */
    deliver,

    /** Start subscribing to the queue */
    start(): void {
      if (unsubscribe) return;
      unsubscribe = queue.subscribe(deliver);
    },

    /** Stop the worker */
    stop(): void {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },

    get isRunning(): boolean {
      return unsubscribe !== null;
    },
  };
}
