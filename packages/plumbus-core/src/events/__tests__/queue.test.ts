import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '../../types/event.js';
import {
  createInMemoryQueue,
  createRedisQueue,
  leaseRenewalIntervalMs,
  type RedisClient,
  RedisQueueScripts,
} from '../queue.js';

function makeEnvelope(overrides?: Partial<EventEnvelope>): EventEnvelope {
  return {
    id: 'evt-1',
    eventType: 'order.created',
    version: '1',
    occurredAt: new Date(),
    actor: 'user-1',
    correlationId: 'corr-1',
    payload: { orderId: '123' },
    ...overrides,
  };
}

describe('InMemoryQueue', () => {
  it('delivers published events to subscribers', async () => {
    const queue = createInMemoryQueue();
    const received: EventEnvelope[] = [];
    queue.subscribe(async (e) => {
      received.push(e);
    });

    await queue.publish(makeEnvelope());
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('evt-1');
  });

  it('delivers to multiple subscribers', async () => {
    const queue = createInMemoryQueue();
    const a: string[] = [];
    const b: string[] = [];
    queue.subscribe(async (e) => {
      a.push(e.id);
    });
    queue.subscribe(async (e) => {
      b.push(e.id);
    });

    await queue.publish(makeEnvelope());
    expect(a).toEqual(['evt-1']);
    expect(b).toEqual(['evt-1']);
  });

  it('unsubscribe removes handler', async () => {
    const queue = createInMemoryQueue();
    const received: string[] = [];
    const unsub = queue.subscribe(async (e) => {
      received.push(e.id);
    });
    unsub();

    await queue.publish(makeEnvelope());
    expect(received).toEqual([]);
  });

  it('throws on publish after close', async () => {
    const queue = createInMemoryQueue();
    await queue.close();
    await expect(queue.publish(makeEnvelope())).rejects.toThrow('closed');
  });

  it('throws on subscribe after close', async () => {
    const queue = createInMemoryQueue();
    await queue.close();
    expect(() => queue.subscribe(async () => {})).toThrow('closed');
  });

  it('swallows subscriber errors without affecting others', async () => {
    const queue = createInMemoryQueue();
    const received: string[] = [];
    queue.subscribe(async () => {
      throw new Error('boom');
    });
    queue.subscribe(async (e) => {
      received.push(e.id);
    });

    await queue.publish(makeEnvelope());
    expect(received).toEqual(['evt-1']);
  });
});

// Minimal Redis client over in-memory lists so the lease-renewal timer can be
// tested without a live Redis server. Only the scripts createRedisQueue uses
// are implemented.
function createFakeRedisClient(): RedisClient & { renewCount: () => number } {
  const lists = new Map<string, string[]>();
  let renews = 0;
  const list = (key: string): string[] => {
    let entries = lists.get(key);
    if (!entries) {
      entries = [];
      lists.set(key, entries);
    }
    return entries;
  };
  return {
    async lpush(key, ...values) {
      list(key).unshift(...values);
      return values.length;
    },
    async lrem(key, count, value) {
      const entries = list(key);
      let removed = 0;
      while (removed < count) {
        const index = entries.indexOf(value);
        if (index === -1) break;
        entries.splice(index, 1);
        removed++;
      }
      return removed;
    },
    async lrange(key, start, stop) {
      return list(key).slice(start, stop === -1 ? undefined : stop + 1);
    },
    async eval(script, options) {
      const keys = options.keys.map(list);
      if (script === RedisQueueScripts.claim) {
        const pending = keys[0];
        const processing = keys[1];
        if (!pending || !processing) throw new Error('missing claim keys');
        const raw = pending.at(-1);
        if (raw === undefined) return null;
        const wrapped = JSON.stringify({
          envelope: raw,
          dequeuedAt: Date.now(),
          deliveryId: options.arguments[1],
        });
        processing.unshift(wrapped);
        pending.pop();
        return wrapped;
      }
      if (script === RedisQueueScripts.renew) {
        const processing = keys[0];
        if (!processing) throw new Error('missing renew key');
        const raw = options.arguments[0];
        const index = processing.indexOf(raw);
        if (typeof raw !== 'string' || index === -1) return 0;
        renews++;
        const updated = JSON.stringify({
          ...(JSON.parse(raw) as Record<string, unknown>),
          dequeuedAt: Date.now(),
        });
        processing[index] = updated;
        return updated;
      }
      if (script === RedisQueueScripts.reclaim) return 0;
      throw new Error('unexpected queue script');
    },
    async quit() {},
    renewCount: () => renews,
  };
}

describe('RedisQueue lease renewal', () => {
  const NEVER_RECLAIM_SEC = 10 * 365 * 24 * 60 * 60;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the renewal interval within the Node timer cap', () => {
    expect(leaseRenewalIntervalMs(30_000)).toBe(10_000);
    expect(leaseRenewalIntervalMs(90)).toBe(30);
    expect(leaseRenewalIntervalMs(3)).toBe(1);
    // A 30-day visibility timeout still renews every 10 days.
    expect(leaseRenewalIntervalMs(30 * 24 * 60 * 60 * 1000)).toBe(10 * 24 * 60 * 60 * 1000);
    // Intervals above 2^31 - 1 ms overflow Node timers, which then fire every 1 ms.
    expect(leaseRenewalIntervalMs(NEVER_RECLAIM_SEC * 1000)).toBe(2 ** 31 - 1);
    expect(leaseRenewalIntervalMs(3 * 2 ** 31)).toBe(2 ** 31 - 1);
  });

  it('renews a huge visibility timeout at a bounded cadence instead of every 1 ms', async () => {
    const client = createFakeRedisClient();
    const queue = createRedisQueue(client, {
      prefix: 'renewal',
      ownsClient: false,
      pollIntervalMs: 60 * 60 * 1000,
      visibilityTimeoutSec: NEVER_RECLAIM_SEC,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.subscribe(() => gate);
    await queue.publish(makeEnvelope());
    // First poll claims the message; the handler stays in flight.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(client.renewCount()).toBe(0);
    // With the old unclamped interval (10 years / 3 ≈ 105 billion ms) no renewal
    // would ever fire; with the clamp it runs at most once per ~24.8 days.
    await vi.advanceTimersByTimeAsync(50 * 24 * 60 * 60 * 1000);
    expect(client.renewCount()).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(await client.lrange('renewal:processing', 0, -1)).toEqual([]);
    await queue.close();
  });
});
