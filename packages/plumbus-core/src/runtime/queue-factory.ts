// ── Runtime Queue Factory ──
// Resolves events/flows/jobs queues with in-memory (default) or Redis backends.

import type { EventQueue } from '../events/queue.js';
import { createInMemoryQueue, createRedisQueue, type RedisClient } from '../events/queue.js';
import type { PlumbusConfig, QueueConfig } from '../types/config.js';
import { DataInternalError, DataValidationError } from '../errors/index.js';
import { z } from 'zod';

export const QueueBackend = {
  Memory: 'memory',
  Redis: 'redis',
} as const;

export type QueueBackend = (typeof QueueBackend)[keyof typeof QueueBackend];

export interface RuntimeQueues {
  events: EventQueue;
  flows: EventQueue;
  jobs: EventQueue;
  backend: QueueBackend;
  /** True when using a durable external broker (Redis), not in-memory. */
  isDurable: boolean;
  /** Flows queue Redis prefix (durable backend only). */
  flowsPrefix?: string;
  /** Shared Redis client (durable backend only). */
  redisClient?: import('../events/queue.js').RedisClient;
  /** Best-effort queue depths (Redis only). */
  getDepths?: () => Promise<{ events: number; flows: number; jobs: number }>;
  /** Ping Redis when durable (for /ready probes). */
  pingRedis?: () => Promise<void>;
  close(): Promise<void>;
}

export interface ResolveRuntimeQueuesOptions {
  /** Force in-memory even when Redis is configured (dev default). */
  preferInMemory?: boolean;
  onWarning?: (message: string) => void;
}

function queueUrlFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.QUEUE_URL ?? env.REDIS_URL;
}

function explicitBackend(env: Record<string, string | undefined>): QueueBackend | undefined {
  const raw = env.QUEUE_BACKEND?.toLowerCase();
  if (raw === 'memory') return QueueBackend.Memory;
  if (raw === 'redis') return QueueBackend.Redis;
  return undefined;
}

/** Whether Redis should be used based on config and environment. */
export function shouldUseRedisBackend(
  config: PlumbusConfig,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const forced = config.queue.backend ?? explicitBackend(env);
  if (forced === QueueBackend.Memory) return false;
  if (forced === QueueBackend.Redis) return true;
  if (config.queue.url ?? queueUrlFromEnv(env)) return true;
  // Auto-detect: non-default Redis host/port or explicit password implies intent
  const host = config.queue.host;
  const hasNonDefaultHost = host !== 'localhost' && host !== '127.0.0.1';
  return hasNonDefaultHost || config.queue.port !== 6379 || config.queue.password !== undefined;
}

/** Redis selection is fail-closed; errors never produce memory queues. */
export async function tryCreateRedisClient(
  queueConfig: QueueConfig,
  env: Record<string, string | undefined> = process.env,
  onWarning: (message: string) => void = console.warn,
): Promise<RedisClient> {
  let redis: typeof import('redis');
  try {
    redis = await import('redis');
  } catch {
    throw new DataInternalError('Redis driver unavailable; install redis@^4.7.0', {
      reason: 'redis_driver_missing',
    });
  }
  const startupTimeoutMs = queueConfig.startupTimeoutMs ?? 5000;
  const operationTimeoutMs = queueConfig.operationTimeoutMs ?? 5000;
  for (const value of [startupTimeoutMs, operationTimeoutMs]) {
    if (!z.number().finite().positive().safeParse(value).success) {
      throw new DataValidationError('Redis timeouts must be positive finite numbers');
    }
  }
  async function bounded<T>(operation: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DataInternalError('Redis operation timed out', { reason })),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const url = queueConfig.url ?? queueUrlFromEnv(env);
  let client: ReturnType<typeof redis.createClient>;
  try {
    client = redis.createClient({
      ...(url ? { url } : { password: queueConfig.password }),
      socket: {
        ...(url ? {} : { host: queueConfig.host, port: queueConfig.port }),
        connectTimeout: startupTimeoutMs,
        reconnectStrategy: (retries: number) => Math.min(100 * 2 ** Math.min(retries, 8), 5000),
      },
      disableOfflineQueue: true,
    });
  } catch {
    throw new DataValidationError('Invalid Redis connection configuration', {
      reason: 'redis_configuration',
    });
  }
  let lastWarning = -Infinity;
  let authenticationFailed = false;
  client.on('error', (error) => {
    const parsed = z.object({ message: z.string() }).safeParse(error);
    if (parsed.success && /WRONGPASS|NOAUTH|AUTH/i.test(parsed.data.message))
      authenticationFailed = true;
    if (Date.now() - lastWarning >= 5000) {
      lastWarning = Date.now();
      try {
        onWarning('Redis connection error; backend remains Redis and readiness is unavailable');
      } catch {
        /* observer */
      }
    }
  });
  try {
    await bounded(client.connect(), startupTimeoutMs, 'redis_startup_timeout');
  } catch (error) {
    await client.disconnect().catch(() => {});
    const parsed = z
      .object({
        message: z.string().optional(),
        metadata: z.object({ reason: z.string() }).optional(),
      })
      .safeParse(error);
    const reason = authenticationFailed
      ? 'redis_authentication'
      : parsed.success && parsed.data.metadata?.reason === 'redis_startup_timeout'
        ? 'redis_startup_timeout'
        : parsed.success && /WRONGPASS|NOAUTH|AUTH/i.test(parsed.data.message ?? '')
          ? 'redis_authentication'
          : 'redis_connection';
    throw new DataInternalError(`Redis initialization failed (${reason})`, { reason });
  }
  const call = <T>(operation: Promise<T>) =>
    bounded(operation, operationTimeoutMs, 'redis_operation_timeout');
  let closing: Promise<unknown> | undefined;
  return {
    lpush: (key, ...values) => call(client.lPush(key, ...values)),
    rpoplpush: (source, dest) => call(client.rPopLPush(source, dest)),
    lrem: (key, count, value) => call(client.lRem(key, count, value)),
    lrange: (key, start, stop) => call(client.lRange(key, start, stop)),
    llen: (key) => call(client.lLen(key)),
    zadd: (key, score, member) => call(client.zAdd(key, [{ score, value: member }])),
    zrangebyscore: (key, min, max, options) =>
      call(
        client.zRangeByScore(
          key,
          min,
          max,
          options?.limit != null ? { LIMIT: { offset: 0, count: options.limit } } : undefined,
        ),
      ),
    zrem: (key, member) => call(client.zRem(key, member)),
    ping: () => {
      if (!client.isReady) return Promise.reject(new DataInternalError('Redis is not ready'));
      return call(client.ping());
    },
    eval: (script, options) => call(client.eval(script, options)),
    quit: () => {
      closing ??= (async () => {
        try {
          if (client.isReady) await call(client.quit());
        } finally {
          if (client.isOpen) await client.disconnect().catch(() => {});
        }
      })();
      return closing;
    },
  };
}

function memoryQueues(): RuntimeQueues {
  const events = createInMemoryQueue();
  const flows = createInMemoryQueue();
  const jobs = createInMemoryQueue();
  return {
    events,
    flows,
    jobs,
    backend: QueueBackend.Memory,
    isDurable: false,
    async close() {
      await Promise.all([events.close(), flows.close(), jobs.close()]);
    },
  };
}

/**
 * Resolve the three runtime queues (events, flows, jobs).
 * Default: in-memory (backward compatible). Redis when configured and available.
 */
export async function resolveRuntimeQueues(
  config: PlumbusConfig,
  options?: ResolveRuntimeQueuesOptions,
): Promise<RuntimeQueues> {
  const env = process.env;
  const warn = options?.onWarning ?? console.warn;

  if (
    options?.preferInMemory ||
    (config.queue.backend ?? explicitBackend(env)) === QueueBackend.Memory
  ) {
    return memoryQueues();
  }

  const wantsRedis = shouldUseRedisBackend(config, env);

  if (!wantsRedis) {
    if (config.environment === 'production' || config.environment === 'staging') {
      warn(
        'In-memory queue is active (single-instance only). Configure Redis (QUEUE_URL or REDIS_HOST) for multi-replica deployments.',
      );
    }
    return memoryQueues();
  }

  const redisClient = await tryCreateRedisClient(config.queue, env, warn);
  const client = redisClient;
  const basePrefix = config.queue.prefix ?? `plumbus:${config.environment}`;
  const queueOpts = {
    visibilityTimeoutSec: config.queue.visibilityTimeoutSec,
    pollIntervalMs: config.queue.pollIntervalMs,
    reclaimIntervalMs: config.queue.reclaimIntervalMs,
    shutdownTimeoutMs: config.queue.shutdownTimeoutMs,
    ownsClient: false,
  };
  const eventsPrefix = `${basePrefix}:events`;
  const flowsPrefix = `${basePrefix}:flows`;
  const jobsPrefix = `${basePrefix}:jobs`;
  const events = createRedisQueue(client, { prefix: eventsPrefix, ...queueOpts });
  const flows = createRedisQueue(client, { prefix: flowsPrefix, ...queueOpts });
  const jobs = createRedisQueue(client, { prefix: jobsPrefix, ...queueOpts });

  async function depthFor(prefix: string): Promise<number> {
    if (!client.llen) return 0;
    const pending = await client.llen(`${prefix}:pending`);
    const processing = await client.llen(`${prefix}:processing`);
    return pending + processing;
  }

  return {
    events,
    flows,
    jobs,
    backend: QueueBackend.Redis,
    isDurable: true,
    flowsPrefix,
    redisClient: client,
    async getDepths() {
      const [eventsDepth, flowsDepth, jobsDepth] = await Promise.all([
        depthFor(eventsPrefix),
        depthFor(flowsPrefix),
        depthFor(jobsPrefix),
      ]);
      return { events: eventsDepth, flows: flowsDepth, jobs: jobsDepth };
    },
    async pingRedis() {
      await client.ping?.();
    },
    async close() {
      await Promise.all([events.close(), flows.close(), jobs.close()]);
      await client.quit();
    },
  };
}
