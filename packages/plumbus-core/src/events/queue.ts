import type { EventEnvelope } from '../types/event.js';

/**
 * Abstract queue interface for publishing and consuming event envelopes.
 * Implementations can back this with in-memory arrays (dev/test),
 * Redis/BullMQ, SQS, etc.
 */
export interface EventQueue {
  /** Enqueue an event for delivery to consumers */
  publish(envelope: EventEnvelope): Promise<void>;
  /** Subscribe to incoming events. Returns an unsubscribe function. */
  subscribe(handler: (envelope: EventEnvelope) => Promise<void>): () => void;
  /** Drain / shutdown the queue gracefully */
  close(): Promise<void>;
}

/**
 * Simple in-memory queue for development and testing.
 * Events are delivered asynchronously to all subscribers.
 */
export function createInMemoryQueue(): EventQueue {
  const subscribers: Array<(envelope: EventEnvelope) => Promise<void>> = [];
  let closed = false;
  const pending: Promise<void>[] = [];

  return {
    async publish(envelope: EventEnvelope): Promise<void> {
      if (closed) throw new Error('Queue is closed');
      for (const handler of subscribers) {
        const p = handler(envelope).catch(() => {
          /* delivery errors handled by worker */
        });
        pending.push(p);
      }
    },

    subscribe(handler: (envelope: EventEnvelope) => Promise<void>): () => void {
      if (closed) throw new Error('Queue is closed');
      subscribers.push(handler);
      return () => {
        const idx = subscribers.indexOf(handler);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },

    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled(pending);
      subscribers.length = 0;
    },
  };
}

// ── Redis Queue Adapter ──
// Uses Redis lists for durable, at-least-once event delivery.
// Compatible with BullMQ-style patterns but uses raw Redis commands
// for zero additional dependencies.

export interface RedisQueueConfig {
  /** Redis connection URL (e.g., redis://localhost:6379) */
  url?: string;
  /** Redis host (default: "localhost") */
  host?: string;
  /** Redis port (default: 6379) */
  port?: number;
  /** Redis password */
  password?: string;
  /** Queue key prefix (default: "plumbus:events") */
  prefix?: string;
  /** Poll interval in ms for subscriber polling (default: 1000) */
  pollIntervalMs?: number;
  /** Visibility timeout in seconds — how long a message is hidden after dequeue (default: 30) */
  visibilityTimeoutSec?: number;
}

/** Minimal Redis client interface — compatible with ioredis and node-redis */
export interface RedisClient {
  lpush(key: string, ...values: string[]): Promise<number>;
  brpoplpush?(source: string, destination: string, timeout: number): Promise<string | null>;
  rpoplpush?(source: string, destination: string): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen?(key: string): Promise<number>;
  zadd?(key: string, score: number, member: string): Promise<number>;
  zrangebyscore?(
    key: string,
    min: number,
    max: number,
    options?: { limit?: number },
  ): Promise<string[]>;
  zrem?(key: string, member: string): Promise<number>;
  ping?(): Promise<string>;
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface RedisQueueOptions extends Partial<RedisQueueConfig> {
  /** When false, close() does not quit the shared Redis client (default: true). */
  ownsClient?: boolean;
}

/**
 * Create a Redis-backed event queue.
 *
 * Uses a simple list-based pattern:
 * - Publish: LPUSH events to the queue list
 * - Subscribe: Poll with RPOPLPUSH to a processing list
 * - Ack: LREM from processing list after successful handling
 *
 * This provides at-least-once delivery with crash recovery:
 * if the consumer crashes, unacknowledged events remain in the
 * processing list and can be recovered.
 */
interface ProcessingEntry {
  raw: string;
  dequeuedAt: number;
}

function parseProcessingEntry(raw: string): ProcessingEntry {
  try {
    const parsed = JSON.parse(raw) as { envelope?: string; dequeuedAt?: number };
    if (typeof parsed.envelope === 'string' && typeof parsed.dequeuedAt === 'number') {
      return { raw, dequeuedAt: parsed.dequeuedAt };
    }
  } catch {
    /* legacy plain envelope payload */
  }
  return { raw, dequeuedAt: 0 };
}

function wrapForProcessing(envelopeJson: string): string {
  return JSON.stringify({ envelope: envelopeJson, dequeuedAt: Date.now() });
}

function unwrapEnvelope(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { envelope?: string };
    if (typeof parsed.envelope === 'string') {
      return parsed.envelope;
    }
  } catch {
    /* legacy */
  }
  return raw;
}

export function createRedisQueue(client: RedisClient, config?: RedisQueueOptions): EventQueue {
  const prefix = config?.prefix ?? 'plumbus:events';
  const pollIntervalMs = config?.pollIntervalMs ?? 1000;
  const visibilityTimeoutMs = (config?.visibilityTimeoutSec ?? 30) * 1000;
  const ownsClient = config?.ownsClient ?? true;
  const queueKey = `${prefix}:pending`;
  const processingKey = `${prefix}:processing`;

  const REWRAP_SCRIPT = `
local raw = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
if not raw then return nil end
local wrapped = cjson.encode({ envelope = raw, dequeuedAt = tonumber(ARGV[1]) })
redis.call('LREM', KEYS[2], 1, raw)
redis.call('LPUSH', KEYS[2], wrapped)
return wrapped
`;

  async function dequeueWrapped(): Promise<string | null> {
    if (client.eval) {
      const result = await client.eval(REWRAP_SCRIPT, {
        keys: [queueKey, processingKey],
        arguments: [String(Date.now())],
      });
      return typeof result === 'string' ? result : null;
    }

    let raw: string | null = null;
    if (client.rpoplpush) {
      raw = await client.rpoplpush(queueKey, processingKey);
    } else if (client.brpoplpush) {
      raw = await client.brpoplpush(queueKey, processingKey, 0);
    }
    if (!raw) return null;

    const wrapped = wrapForProcessing(raw);
    await client.lrem(processingKey, 1, raw);
    await client.lpush(processingKey, wrapped);
    return wrapped;
  }

  const subscribers: Array<(envelope: EventEnvelope) => Promise<void>> = [];
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  async function recoverStaleProcessing(): Promise<void> {
    const processing = await client.lrange(processingKey, 0, -1);
    const now = Date.now();
    for (const entry of processing) {
      const { raw, dequeuedAt } = parseProcessingEntry(entry);
      const isLegacy = dequeuedAt === 0;
      const isStale = isLegacy || (dequeuedAt > 0 && now - dequeuedAt >= visibilityTimeoutMs);
      if (isStale) {
        await client.lrem(processingKey, 1, raw);
        await client.lpush(queueKey, unwrapEnvelope(raw));
      }
    }
  }

  async function pollOnce(): Promise<void> {
    if (closed || polling || subscribers.length === 0) return;
    polling = true;

    try {
      await recoverStaleProcessing();

      const raw = await dequeueWrapped();
      if (!raw) {
        polling = false;
        return;
      }

      const envelopeJson = unwrapEnvelope(raw);
      const envelope = JSON.parse(envelopeJson) as EventEnvelope;
      // Restore Date object
      if (typeof envelope.occurredAt === 'string') {
        envelope.occurredAt = new Date(envelope.occurredAt);
      }

      // Deliver to all subscribers
      const results = await Promise.allSettled(subscribers.map((handler) => handler(envelope)));

      // If at least one subscriber succeeded, acknowledge the message
      const anySuccess = results.some((r) => r.status === 'fulfilled');
      if (anySuccess) {
        await client.lrem(processingKey, 1, raw);
      }
    } catch {
      // Poll errors are transient — will retry next cycle
    } finally {
      polling = false;
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
  }

  return {
    async publish(envelope: EventEnvelope): Promise<void> {
      if (closed) throw new Error('Queue is closed');
      const serialized = JSON.stringify(envelope);
      await client.lpush(queueKey, serialized);
    },

    subscribe(handler: (envelope: EventEnvelope) => Promise<void>): () => void {
      if (closed) throw new Error('Queue is closed');
      subscribers.push(handler);
      startPolling();
      return () => {
        const idx = subscribers.indexOf(handler);
        if (idx !== -1) subscribers.splice(idx, 1);
        if (subscribers.length === 0 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    },

    async close(): Promise<void> {
      closed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      subscribers.length = 0;
      if (ownsClient) {
        await client.quit();
      }
    },
  };
}
