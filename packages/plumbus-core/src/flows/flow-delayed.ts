import type { RedisClient } from '../events/queue.js';
import type { EventQueue } from '../events/queue.js';
import { enqueueFlowStep } from './flow-queue.js';

/** Redis sorted-set key suffix for delayed flow wake promotions. */
export const FLOW_DELAYED_KEY_SUFFIX = ':delayed';

export function flowDelayedKey(queuePrefix: string): string {
  return `${queuePrefix}${FLOW_DELAYED_KEY_SUFFIX}`;
}

export interface ScheduleDelayedFlowWakeOptions {
  client: RedisClient;
  /** Flows queue prefix, e.g. plumbus:production:flows */
  flowsPrefix: string;
  executionId: string;
  wakeAt: Date;
}

/** Add a flow execution to the delayed sorted set (score = wakeAt epoch ms). */
export async function scheduleDelayedFlowWake(
  options: ScheduleDelayedFlowWakeOptions,
): Promise<void> {
  const { client, flowsPrefix, executionId, wakeAt } = options;
  if (!client.zadd) {
    throw new Error('Redis client does not support sorted sets (zadd)');
  }
  await client.zadd(flowDelayedKey(flowsPrefix), wakeAt.getTime(), executionId);
}

export interface FlowDelayedPromoterConfig {
  client: RedisClient;
  flowsPrefix: string;
  flowsQueue: EventQueue;
  pollIntervalMs?: number;
  batchSize?: number;
  logger?: {
    info?(msg: string, meta?: Record<string, unknown>): void;
    warn?(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Poll the delayed sorted set and promote due executions to the flows queue.
 * Complements the DB poll loop — Redis provides timely wake for durable deployments.
 */
export function createFlowDelayedPromoter(config: FlowDelayedPromoterConfig): {
  start(): void;
  stop(): void;
  promoteOnce(): Promise<number>;
} {
  const { client, flowsPrefix, flowsQueue, pollIntervalMs = 1000, batchSize = 50, logger } = config;
  const delayedKey = flowDelayedKey(flowsPrefix);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function promoteOnce(): Promise<number> {
    if (!client.zrangebyscore || !client.zrem) {
      return 0;
    }
    const now = Date.now();
    const due = await client.zrangebyscore(delayedKey, 0, now, { limit: batchSize });
    let promoted = 0;
    for (const executionId of due) {
      const removed = await client.zrem(delayedKey, executionId);
      if (removed > 0) {
        await enqueueFlowStep(flowsQueue, executionId);
        promoted += 1;
      }
    }
    if (promoted > 0) {
      logger?.info?.('Promoted delayed flow wakes', { promoted, delayedKey });
    }
    return promoted;
  }

  async function tick(): Promise<void> {
    try {
      await promoteOnce();
    } catch (err: unknown) {
      const details = { error: err instanceof Error ? err.message : String(err), delayedKey };
      if (logger?.warn)
        logger.warn('Delayed flow wake promotion failed; retrying next tick', details);
      else
        console.warn('[plumbus] delayed flow wake promotion failed; retrying next tick', details);
    }
  }

  return {
    promoteOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, pollIntervalMs);
      void tick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
