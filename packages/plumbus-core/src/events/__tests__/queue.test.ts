import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataInternalError } from '../../errors/index.js';
import type { EventEnvelope } from '../../types/event.js';
import {
  createInMemoryQueue,
  createRedisQueue,
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

describe('RedisQueue lease renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mockDelivery() {
    const envelope = JSON.stringify(makeEnvelope());
    const raw = JSON.stringify({ envelope, dequeuedAt: Date.now(), deliveryId: 'delivery-1' });
    let claimed = false;
    const evaluate = vi.fn<NonNullable<RedisClient['eval']>>(async (script) => {
      if (script === RedisQueueScripts.claim && !claimed) {
        claimed = true;
        return raw;
      }
      if (script === RedisQueueScripts.renew) {
        return JSON.stringify({ envelope, dequeuedAt: Date.now(), deliveryId: 'delivery-1' });
      }
      return 0;
    });
    const client: RedisClient = {
      lpush: vi.fn(async () => 1),
      lrem: vi.fn(async () => 1),
      lrange: vi.fn(async () => []),
      eval: evaluate,
      quit: vi.fn(async () => {}),
    };
    return { client, evaluate };
  }

  it.each([
    { visibilityTimeoutSec: undefined, renewalIntervalMs: 10000, leaseDurationMs: 30000 },
    { visibilityTimeoutSec: 0.001, renewalIntervalMs: 1, leaseDurationMs: 1 },
    { visibilityTimeoutSec: 0.005, renewalIntervalMs: 1, leaseDurationMs: 5 },
    { visibilityTimeoutSec: 2, renewalIntervalMs: 666, leaseDurationMs: 2000 },
    { visibilityTimeoutSec: 29.997, renewalIntervalMs: 9999, leaseDurationMs: 29997 },
    { visibilityTimeoutSec: 30, renewalIntervalMs: 10000, leaseDurationMs: 30000 },
    { visibilityTimeoutSec: 30.003, renewalIntervalMs: 10001, leaseDurationMs: 30003 },
    { visibilityTimeoutSec: 60, renewalIntervalMs: 20000, leaseDurationMs: 60000 },
    { visibilityTimeoutSec: 3600, renewalIntervalMs: 1200000, leaseDurationMs: 3600000 },
    {
      visibilityTimeoutSec: (2_147_483_646 * 3) / 1000,
      renewalIntervalMs: 2_147_483_646,
      leaseDurationMs: 6_442_450_938,
    },
    {
      visibilityTimeoutSec: (2_147_483_647 * 3) / 1000,
      renewalIntervalMs: 2_147_483_647,
      leaseDurationMs: 6_442_450_941,
    },
    {
      visibilityTimeoutSec: (2_147_483_648 * 3) / 1000,
      renewalIntervalMs: 10000,
      leaseDurationMs: 30000,
    },
    {
      visibilityTimeoutSec: 10 * 365 * 24 * 60 * 60,
      renewalIntervalMs: 10000,
      leaseDurationMs: 30000,
    },
  ])('schedules safe renewals for visibilityTimeoutSec=$visibilityTimeoutSec', async ({
    visibilityTimeoutSec,
    renewalIntervalMs,
    leaseDurationMs,
  }) => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const { client, evaluate } = mockDelivery();
    const queue = createRedisQueue(client, { pollIntervalMs: 5, visibilityTimeoutSec });
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn(() => pending);
    queue.subscribe(handler);
    try {
      await vi.advanceTimersByTimeAsync(5);
      expect(handler).toHaveBeenCalledOnce();
      // Check the actual delay, since fake timers need not reproduce Node's overflow behavior.
      expect(interval).toHaveBeenLastCalledWith(expect.any(Function), renewalIntervalMs);
      expect(evaluate).toHaveBeenCalledWith(RedisQueueScripts.reclaim, {
        keys: ['plumbus:events:processing', 'plumbus:events:pending'],
        arguments: [String((visibilityTimeoutSec ?? 30) * 1000)],
      });
      expect(evaluate).toHaveBeenCalledWith(RedisQueueScripts.claim, {
        keys: ['plumbus:events:pending', 'plumbus:events:processing'],
        arguments: [expect.any(String), expect.any(String), String(leaseDurationMs)],
      });
      await vi.advanceTimersByTimeAsync(Math.min(1000, renewalIntervalMs - 1));
      expect(evaluate).not.toHaveBeenCalledWith(RedisQueueScripts.renew, expect.anything());
      expect(client.lrem).not.toHaveBeenCalled();
    } finally {
      finish();
      await queue.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { visibilityTimeoutSec: 60, renewalIntervalMs: 20000, leaseDurationMs: 60000 },
    {
      visibilityTimeoutSec: 10 * 365 * 24 * 60 * 60,
      renewalIntervalMs: 10000,
      leaseDurationMs: 30000,
    },
  ])('renews active delivery at the compatible cadence (visibility=$visibilityTimeoutSec)', async ({
    visibilityTimeoutSec,
    renewalIntervalMs,
    leaseDurationMs,
  }) => {
    const { client, evaluate } = mockDelivery();
    const queue = createRedisQueue(client, {
      pollIntervalMs: 1000,
      visibilityTimeoutSec,
    });
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    queue.subscribe(() => pending);
    const renewals = () =>
      evaluate.mock.calls.filter(([script]) => script === RedisQueueScripts.renew);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(renewalIntervalMs - 1);
      expect(renewals()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(renewals()).toHaveLength(1);
      expect(evaluate).toHaveBeenLastCalledWith(RedisQueueScripts.renew, {
        keys: ['plumbus:events:processing'],
        arguments: [expect.any(String), String(leaseDurationMs)],
      });
      await vi.advanceTimersByTimeAsync(renewalIntervalMs);
      expect(renewals()).toHaveLength(2);
    } finally {
      finish();
      await queue.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    false,
    true,
  ])('stops renewing after the handler settles (rejects=%s)', async (rejects) => {
    const { client, evaluate } = mockDelivery();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const queue = createRedisQueue(client, {
      pollIntervalMs: 5,
      visibilityTimeoutSec: 0.09,
      logger,
    });
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = queue.subscribe(async () => {
      await pending;
      if (rejects) throw new DataInternalError('Handler failed');
    });
    try {
      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(29);
      expect(evaluate).not.toHaveBeenCalledWith(RedisQueueScripts.renew, expect.anything());
      await vi.advanceTimersByTimeAsync(1);
      const renewed = await evaluate.mock.results.at(-1)?.value;
      expect(typeof renewed).toBe('string');
      expect(evaluate).toHaveBeenLastCalledWith(RedisQueueScripts.renew, expect.anything());

      unsubscribe();
      finish();
      await vi.advanceTimersByTimeAsync(0);
      if (rejects) {
        expect(client.lrem).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledOnce();
      } else {
        expect(client.lrem).toHaveBeenCalledExactlyOnceWith(
          'plumbus:events:processing',
          1,
          renewed,
        );
        expect(logger.error).not.toHaveBeenCalled();
      }
      const calls = evaluate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90);
      expect(evaluate).toHaveBeenCalledTimes(calls);
    } finally {
      finish();
      await queue.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'error',
    'lost',
  ])('leaves delivery recoverable when renewal fails (%s)', async (failure) => {
    const { client, evaluate } = mockDelivery();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const queue = createRedisQueue(client, {
      pollIntervalMs: 5,
      visibilityTimeoutSec: 0.09,
      logger,
    });
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = queue.subscribe(() => pending);
    try {
      await vi.advanceTimersByTimeAsync(5);
      if (failure === 'error') {
        evaluate.mockRejectedValueOnce(new DataInternalError('Redis unavailable'));
      } else {
        evaluate.mockResolvedValueOnce(0);
      }
      await vi.advanceTimersByTimeAsync(30);
      expect(evaluate).toHaveBeenLastCalledWith(RedisQueueScripts.renew, expect.anything());
      const calls = evaluate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90);
      expect(evaluate).toHaveBeenCalledTimes(calls);
      unsubscribe();
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.lrem).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledOnce();
    } finally {
      finish();
      await queue.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
