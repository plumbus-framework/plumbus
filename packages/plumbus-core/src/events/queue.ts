import { z } from 'zod';
import { DataInternalError, DataValidationError } from '../errors/index.js';
import type { LoggerService } from '../types/context.js';
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
  reclaimIntervalMs?: number;
  shutdownTimeoutMs?: number;
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
  logger?: Pick<LoggerService, 'error' | 'warn'>;
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

// All transitions validate types before writing. Redis scripts are atomic, but
// do not roll back earlier writes if a later command fails.
const listCheck = `
for _, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  if kind ~= 'none' and kind ~= 'list' then
    return redis.error_reply('Queue key must be a list')
  end
end
`;
export const RedisQueueScripts = {
  claim: `${listCheck}
local raw = redis.call('LINDEX', KEYS[1], -1)
if not raw then return nil end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local wrapped = cjson.encode({ envelope = raw, dequeuedAt = now, deliveryId = ARGV[2] })
redis.call('LPUSH', KEYS[2], wrapped)
redis.call('RPOP', KEYS[1])
return wrapped
`,
  transfer: `${listCheck}
for _, entry in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
  if entry == ARGV[1] then
    redis.call('LPUSH', KEYS[2], ARGV[2])
    redis.call('LREM', KEYS[1], 1, ARGV[1])
    return 1
  end
end
return 0
`,
  reclaim: `${listCheck}
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local moved = 0
for _, entry in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
  local ok, decoded = pcall(cjson.decode, entry)
  local wrapped = ok and type(decoded) == 'table' and type(decoded.envelope) == 'string'
  local dequeuedAt = wrapped and tonumber(decoded.dequeuedAt) or 0
  if not dequeuedAt or dequeuedAt == 0 or now - dequeuedAt >= tonumber(ARGV[1]) then
    redis.call('LPUSH', KEYS[2], wrapped and decoded.envelope or entry)
    redis.call('LREM', KEYS[1], 1, entry)
    moved = moved + 1
  end
end
return moved
`,
  renew: `${listCheck}
for index, entry in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
  if entry == ARGV[1] then
    local decoded = cjson.decode(entry)
    local clock = redis.call('TIME')
    decoded.dequeuedAt = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
    local renewed = cjson.encode(decoded)
    redis.call('LSET', KEYS[1], index - 1, renewed)
    return renewed
  end
end
return 0
`,
} as const;

const envelopeSchema = z.object({
  id: z.string().min(1),
  eventType: z.string().min(1),
  version: z.string().min(1),
  occurredAt: z.coerce.date(),
  actor: z.string().min(1),
  tenantId: z.string().optional(),
  correlationId: z.string(),
  causationId: z.string().optional(),
  payload: z.unknown(),
  metadata: z.record(z.unknown()).optional(),
});

export function createRedisQueue(client: RedisClient, config?: RedisQueueOptions): EventQueue {
  if (!client.eval) throw new DataValidationError('Redis queues require atomic script support');
  const evaluate = client.eval.bind(client);
  const prefix = config?.prefix ?? 'plumbus:events';
  const pollIntervalMs = config?.pollIntervalMs ?? 1000;
  const visibilityTimeoutMs = (config?.visibilityTimeoutSec ?? 30) * 1000;
  const reclaimIntervalMs = config?.reclaimIntervalMs ?? Math.min(visibilityTimeoutMs, 5000);
  const shutdownTimeoutMs = config?.shutdownTimeoutMs ?? 5000;
  for (const value of [pollIntervalMs, visibilityTimeoutMs, reclaimIntervalMs, shutdownTimeoutMs]) {
    if (!z.number().finite().positive().safeParse(value).success) {
      throw new DataValidationError('Queue timing values must be positive finite numbers');
    }
  }
  const ownsClient = config?.ownsClient ?? true;
  const logger = config?.logger ?? console;
  const queueKey = `${prefix}:pending`;
  const processingKey = `${prefix}:processing`;
  const subscribers: Array<(envelope: EventEnvelope) => Promise<void>> = [];
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let activePoll: Promise<void> | undefined;
  let activeRenewal: ReturnType<typeof setInterval> | undefined;
  let nextReclaim = 0;
  let lastErrorLog = -Infinity;
  let nextPoll = 0;
  let failures = 0;
  let closePromise: Promise<void> | undefined;

  function report(operation: string): void {
    failures++;
    nextPoll =
      Date.now() + Math.min(30000, Math.max(pollIntervalMs, 100) * 2 ** Math.min(failures - 1, 8));
    // Errors may contain application payloads or Redis credentials. Log identifiers only.
    if (Date.now() - lastErrorLog < 5000) return;
    lastErrorLog = Date.now();
    logger.error('Redis queue operation failed; delivery remains recoverable', {
      prefix,
      operation,
    });
  }

  async function recoverStaleProcessing(): Promise<void> {
    if (Date.now() < nextReclaim) return;
    nextReclaim = Date.now() + reclaimIntervalMs;
    await evaluate(RedisQueueScripts.reclaim, {
      keys: [processingKey, queueKey],
      arguments: [String(visibilityTimeoutMs)],
    });
  }

  async function pollOnce(): Promise<void> {
    try {
      await recoverStaleProcessing();
      if (closed || subscribers.length === 0) return;
      const claimed = await evaluate(RedisQueueScripts.claim, {
        keys: [queueKey, processingKey],
        arguments: [String(Date.now()), crypto.randomUUID()],
      });
      if (typeof claimed !== 'string') {
        failures = 0;
        return;
      }
      let raw = claimed;
      let decoded: unknown;
      try {
        decoded = JSON.parse(unwrapEnvelope(raw));
      } catch {
        decoded = undefined;
      }
      const parsed = envelopeSchema.safeParse(decoded);
      if (!parsed.success) {
        await evaluate(RedisQueueScripts.transfer, {
          keys: [processingKey, `${prefix}:invalid`],
          arguments: [raw, unwrapEnvelope(raw)],
        });
        logger.warn('Invalid queue envelope quarantined', { prefix });
        return;
      }
      const envelope = { ...parsed.data, payload: parsed.data.payload } as EventEnvelope;
      let lost = false;
      let renewing: Promise<void> | undefined;
      const renewalTimer = setInterval(
        () => {
          if (renewing || closed || lost) return;
          renewing = (async () => {
            const updated = await evaluate(RedisQueueScripts.renew, {
              keys: [processingKey],
              arguments: [raw],
            });
            if (typeof updated === 'string') raw = updated;
            else lost = true;
          })()
            .catch(() => {
              lost = true;
              report('renew');
            })
            .finally(() => {
              renewing = undefined;
            });
        },
        Math.max(1, Math.floor(visibilityTimeoutMs / 3)),
      );
      activeRenewal = renewalTimer;
      let results: PromiseSettledResult<void>[];
      try {
        results = await Promise.allSettled([...subscribers].map((handler) => handler(envelope)));
      } finally {
        clearInterval(renewalTimer);
        activeRenewal = undefined;
        await renewing;
      }
      if (!lost && results.length > 0 && results.every((result) => result.status === 'fulfilled')) {
        await client.lrem(processingKey, 1, raw);
        failures = 0;
      } else {
        report('delivery');
      }
    } catch {
      report('poll');
    }
  }

  return {
    async publish(envelope) {
      if (closed) throw new DataInternalError('Queue is closed');
      await client.lpush(queueKey, JSON.stringify(envelope));
    },
    subscribe(handler) {
      if (closed) throw new DataInternalError('Queue is closed');
      subscribers.push(handler);
      pollTimer ??= setInterval(() => {
        if (!activePoll && !closed && subscribers.length > 0 && Date.now() >= nextPoll) {
          activePoll = pollOnce().finally(() => {
            activePoll = undefined;
          });
        }
      }, pollIntervalMs);
      return () => {
        const index = subscribers.indexOf(handler);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        clearInterval(pollTimer);
        clearInterval(activeRenewal);
        activeRenewal = undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            activePoll,
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, shutdownTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        subscribers.length = 0;
        if (ownsClient) await client.quit();
      })();
      return closePromise;
    },
  };
}
