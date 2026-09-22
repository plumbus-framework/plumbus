// ── Runtime Queue Factory ──
// Resolves events/flows/jobs queues with in-memory (default) or Redis backends.

import type { EventQueue } from '../events/queue.js';
import { createInMemoryQueue, createRedisQueue, type RedisClient } from '../events/queue.js';
import type { PlumbusConfig, QueueConfig } from '../types/config.js';

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
  const forced = explicitBackend(env);
  if (forced === QueueBackend.Memory) return false;
  if (forced === QueueBackend.Redis) return true;
  if (queueUrlFromEnv(env)) return true;
  // Auto-detect: non-default Redis host/port or explicit password implies intent
  const host = config.queue.host;
  const hasNonDefaultHost = host !== 'localhost' && host !== '127.0.0.1';
  return hasNonDefaultHost || config.queue.password !== undefined;
}

/** Lazy-load redis package; returns null when not installed. */
export async function tryCreateRedisClient(
  queueConfig: QueueConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<RedisClient | null> {
  try {
    const redisMod = (await import('redis')) as {
      createClient: (opts: {
        url?: string;
        socket?: { host: string; port: number };
        password?: string;
      }) => {
        connect: () => Promise<void>;
        lPush: (key: string, ...values: string[]) => Promise<number>;
        rPopLPush: (source: string, dest: string) => Promise<string | null>;
        lRem: (key: string, count: number, value: string) => Promise<number>;
        lRange: (key: string, start: number, stop: number) => Promise<string[]>;
        lLen?: (key: string) => Promise<number>;
        zAdd?: (key: string, members: { score: number; value: string }[]) => Promise<number>;
        zRangeByScore?: (
          key: string,
          min: number | string,
          max: number | string,
          options?: { LIMIT?: { offset: number; count: number } },
        ) => Promise<string[]>;
        zRem?: (key: string, member: string) => Promise<number>;
        ping?: () => Promise<string>;
        eval?: (
          script: string,
          options: { keys: string[]; arguments: string[] },
        ) => Promise<unknown>;
        quit: () => Promise<unknown>;
      };
    };
    const url = queueUrlFromEnv(env);
    const client = url
      ? redisMod.createClient({ url })
      : redisMod.createClient({
          socket: { host: queueConfig.host, port: queueConfig.port },
          password: queueConfig.password,
        });
    await client.connect();
    return {
      lpush: (key, ...values) => client.lPush(key, ...values),
      rpoplpush: (source, dest) => client.rPopLPush(source, dest),
      lrem: (key, count, value) => client.lRem(key, count, value),
      lrange: (key, start, stop) => client.lRange(key, start, stop),
      llen: (key) => (client.lLen ? client.lLen(key) : Promise.resolve(0)),
      zadd: (key, score, member) =>
        client.zAdd
          ? client.zAdd(key, [{ score, value: member }])
          : Promise.reject(new Error('Redis client does not support ZADD')),
      zrangebyscore: (key, min, max, options) => {
        if (!client.zRangeByScore) {
          return Promise.reject(new Error('Redis client does not support ZRANGEBYSCORE'));
        }
        const limit = options?.limit;
        return client.zRangeByScore(
          key,
          min,
          max,
          limit != null ? { LIMIT: { offset: 0, count: limit } } : undefined,
        );
      },
      zrem: (key, member) =>
        client.zRem
          ? client.zRem(key, member)
          : Promise.reject(new Error('Redis client does not support ZREM')),
      ping: () => (client.ping ? client.ping() : Promise.resolve('PONG')),
      eval: (script, options) =>
        client.eval
          ? client.eval(script, { keys: options.keys, arguments: options.arguments })
          : Promise.resolve(null),
      quit: () => client.quit(),
    };
  } catch {
    return null;
  }
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
  const warn = options?.onWarning ?? (() => {});

  if (options?.preferInMemory || explicitBackend(env) === QueueBackend.Memory) {
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

  const redisClient = await tryCreateRedisClient(config.queue, env);
  if (!redisClient) {
    warn(
      'Redis queue requested but the "redis" package is not installed. Falling back to in-memory queue. Run: pnpm add redis',
    );
    return memoryQueues();
  }

  const client = redisClient;
  const basePrefix = config.queue.prefix ?? `plumbus:${config.environment}`;
  const queueOpts = {
    visibilityTimeoutSec: config.queue.visibilityTimeoutSec,
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
