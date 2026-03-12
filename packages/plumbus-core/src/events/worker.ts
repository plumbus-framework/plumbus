import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { EventEnvelope } from '../types/event.js';
import type { ConsumerRegistry } from './consumer-registry.js';
import type { IdempotencyService } from './idempotency.js';
import { deadLetterTable } from './outbox.js';
import type { EventQueue } from './queue.js';

export interface WorkerConfig {
  db: PostgresJsDatabase;
  queue: EventQueue;
  consumers: ConsumerRegistry;
  idempotency: IdempotencyService;
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
    retryBackoffBaseMs = 100,
    retryBackoffMaxMs = 5000,
  } = config;

  let unsubscribe: (() => void) | null = null;

  /** Compute exponential backoff with jitter */
  function computeRetryDelay(attempt: number): number {
    const base = Math.min(retryBackoffBaseMs * 2 ** attempt, retryBackoffMaxMs);
    // Add jitter: random value between 0 and base
    return base + Math.floor(Math.random() * base * 0.5);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function deliver(envelope: EventEnvelope): Promise<void> {
    const matched = consumers.getConsumers(envelope.eventType, envelope.version);

    for (const consumer of matched) {
      const maxRetries = consumer.maxRetries ?? defaultMaxRetries;

      // Idempotency guard
      const alreadyProcessed = await idempotency.isProcessed(envelope.id, consumer.id);
      if (alreadyProcessed) continue;

      let lastError: string | undefined;
      let attempt = 0;
      let succeeded = false;

      while (attempt < maxRetries && !succeeded) {
        attempt++;
        try {
          await consumer.handler(envelope);
          succeeded = true;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt < maxRetries) {
            await sleep(computeRetryDelay(attempt - 1));
          }
        }
      }

      if (succeeded) {
        await idempotency.markProcessed(envelope.id, consumer.id);
      } else {
        // Dead-letter
        await db.insert(deadLetterTable).values({
          eventId: envelope.id,
          eventType: envelope.eventType,
          payload: envelope.payload as any,
          consumerId: consumer.id,
          lastError: lastError ?? 'Unknown error',
          retryCount: String(attempt),
          metadata: {
            correlationId: envelope.correlationId,
            causationId: envelope.causationId,
            actor: envelope.actor,
            tenantId: envelope.tenantId,
          },
        });
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
