import { describe, expect, it, vi } from 'vitest';
import { createInMemoryQueue } from '../../events/queue.js';
import type { RedisClient } from '../../events/queue.js';
import {
  createFlowDelayedPromoter,
  flowDelayedKey,
  scheduleDelayedFlowWake,
} from '../flow-delayed.js';

function mockRedisClient(): RedisClient & {
  store: Map<string, Map<string, number>>;
} {
  const store = new Map<string, Map<string, number>>();
  return {
    store,
    async zadd(key, score, member) {
      let bucket = store.get(key);
      if (!bucket) {
        bucket = new Map();
        store.set(key, bucket);
      }
      bucket.set(member, score);
      return 1;
    },
    async zrangebyscore(key, min, max, options) {
      const bucket = store.get(key);
      if (!bucket) return [];
      const limit = options?.limit ?? 100;
      const due = [...bucket.entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member]) => member);
      return due;
    },
    async zrem(key, member) {
      const bucket = store.get(key);
      if (!bucket?.has(member)) return 0;
      bucket.delete(member);
      return 1;
    },
    async quit() {
      return 'OK';
    },
  };
}

describe('flow-delayed', () => {
  it('schedules execution in delayed sorted set', async () => {
    const client = mockRedisClient();
    const prefix = 'plumbus:test:flows';
    const wakeAt = new Date(Date.now() + 60_000);
    await scheduleDelayedFlowWake({
      client,
      flowsPrefix: prefix,
      executionId: 'exec-1',
      wakeAt,
    });
    expect(client.store.get(flowDelayedKey(prefix))?.get('exec-1')).toBe(wakeAt.getTime());
  });

  it('promotes due executions to flows queue', async () => {
    const client = mockRedisClient();
    const prefix = 'plumbus:test:flows';
    const flowsQueue = createInMemoryQueue();
    const publishSpy = vi.spyOn(flowsQueue, 'publish');

    const past = Date.now() - 1000;
    await client.zadd(flowDelayedKey(prefix), past, 'exec-due');

    const promoter = createFlowDelayedPromoter({
      client,
      flowsPrefix: prefix,
      flowsQueue,
      pollIntervalMs: 60_000,
    });

    const promoted = await promoter.promoteOnce();
    expect(promoted).toBe(1);
    expect(publishSpy).toHaveBeenCalled();
    expect(client.store.get(flowDelayedKey(prefix))?.has('exec-due')).toBe(false);
  });

  it('does not promote future wakes', async () => {
    const client = mockRedisClient();
    const prefix = 'plumbus:test:flows';
    const flowsQueue = createInMemoryQueue();
    const future = Date.now() + 60_000;
    await client.zadd(flowDelayedKey(prefix), future, 'exec-future');

    const promoter = createFlowDelayedPromoter({
      client,
      flowsPrefix: prefix,
      flowsQueue,
    });

    expect(await promoter.promoteOnce()).toBe(0);
    expect(client.store.get(flowDelayedKey(prefix))?.has('exec-future')).toBe(true);
  });
});
