import type { EventEnvelope } from '../types/event.js';

/**
 * A consumer function that handles a delivered event.
 */
export type EventConsumerHandler = (envelope: EventEnvelope) => Promise<void>;

export interface EventConsumer {
  /** Unique identifier for this consumer (used for idempotency tracking) */
  id: string;
  /** Event type(s) this consumer subscribes to */
  eventTypes: string[];
  /** Optional version constraint (e.g. "1", ">=2") */
  versionConstraint?: string;
  /** The handler function */
  handler: EventConsumerHandler;
  /** Max retry attempts before dead-lettering (default: 3) */
  maxRetries?: number;
}

/**
 * Registry that holds all registered event consumers,
 * indexed by event type for efficient routing during delivery.
 */
export class ConsumerRegistry {
  private consumers = new Map<string, EventConsumer[]>();
  private consumersById = new Map<string, EventConsumer>();

  /**
   * Register an event consumer. Throws on duplicate consumer ID.
   */
  register(consumer: EventConsumer): void {
    if (this.consumersById.has(consumer.id)) {
      throw new Error(`Event consumer "${consumer.id}" is already registered`);
    }
    this.consumersById.set(consumer.id, consumer);

    for (const eventType of consumer.eventTypes) {
      const existing = this.consumers.get(eventType) ?? [];
      existing.push(consumer);
      this.consumers.set(eventType, existing);
    }
  }

  /**
   * Register multiple consumers at once.
   */
  registerAll(consumers: EventConsumer[]): void {
    for (const consumer of consumers) {
      this.register(consumer);
    }
  }

  /**
   * Get all consumers subscribed to an event type.
   * Optionally filters by version constraint match.
   */
  getConsumers(eventType: string, version?: string): EventConsumer[] {
    const consumers = this.consumers.get(eventType) ?? [];
    if (!version) return consumers;

    return consumers.filter((c) => {
      if (!c.versionConstraint) return true;
      return matchesVersion(version, c.versionConstraint);
    });
  }

  /**
   * Get a specific consumer by ID.
   */
  getById(id: string): EventConsumer | undefined {
    return this.consumersById.get(id);
  }

  /**
   * Get all registered consumers.
   */
  getAll(): EventConsumer[] {
    return Array.from(this.consumersById.values());
  }
}

/**
 * Simple version constraint matcher.
 * Supports: exact match ("1"), >=N (">=2"), <=N, >N, <N.
 */
function matchesVersion(version: string, constraint: string): boolean {
  const v = parseInt(version, 10);
  if (isNaN(v)) return version === constraint;

  const geMatch = constraint.match(/^>=(\d+)$/);
  if (geMatch) return v >= parseInt(geMatch[1]!, 10);

  const leMatch = constraint.match(/^<=(\d+)$/);
  if (leMatch) return v <= parseInt(leMatch[1]!, 10);

  const gtMatch = constraint.match(/^>(\d+)$/);
  if (gtMatch) return v > parseInt(gtMatch[1]!, 10);

  const ltMatch = constraint.match(/^<(\d+)$/);
  if (ltMatch) return v < parseInt(ltMatch[1]!, 10);

  return version === constraint;
}
