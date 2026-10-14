import { describe, expect, it, vi } from 'vitest';
import { createRedisQueue, RedisQueueScripts, type RedisClient } from '../../events/queue.js';

describe('createRedisQueue shared client close', () => {
  it('does not quit Redis client when ownsClient is false', async () => {
    const quit = vi.fn().mockResolvedValue(undefined);
    const client: RedisClient = {
      lpush: vi.fn().mockResolvedValue(1),
      rpoplpush: vi.fn().mockResolvedValue(null),
      lrem: vi.fn().mockResolvedValue(0),
      lrange: vi.fn().mockResolvedValue([]),
      eval: vi.fn().mockResolvedValue(null),
      quit,
    };

    const queue = createRedisQueue(client, { prefix: 'test', ownsClient: false });
    await queue.close();
    expect(quit).not.toHaveBeenCalled();
  });

  it('quits Redis client by default', async () => {
    const quit = vi.fn().mockResolvedValue(undefined);
    const client: RedisClient = {
      lpush: vi.fn().mockResolvedValue(1),
      rpoplpush: vi.fn().mockResolvedValue(null),
      lrem: vi.fn().mockResolvedValue(0),
      lrange: vi.fn().mockResolvedValue([]),
      eval: vi.fn().mockResolvedValue(null),
      quit,
    };

    const queue = createRedisQueue(client, { prefix: 'test' });
    await queue.close();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

it('stops visibility timers when bounded shutdown abandons a hung handler', async () => {
  vi.useFakeTimers();
  try {
    const envelope = {
      id: 'event',
      eventType: 'test',
      version: '1',
      occurredAt: new Date(),
      actor: 'test',
      correlationId: 'event',
      payload: {},
    };
    const client: RedisClient = {
      eval: vi.fn(async (script) =>
        script === RedisQueueScripts.claim
          ? JSON.stringify({ envelope: JSON.stringify(envelope), dequeuedAt: Date.now() })
          : 0,
      ),
      lpush: vi.fn(async () => 1),
      lrange: vi.fn(async () => []),
      lrem: vi.fn(async () => 1),
      quit: vi.fn(async () => {}),
    };
    const queue = createRedisQueue(client, { pollIntervalMs: 5, shutdownTimeoutMs: 20 });
    const handler = vi.fn(() => new Promise<void>(() => {}));
    queue.subscribe(handler);
    await vi.advanceTimersByTimeAsync(5);
    expect(handler).toHaveBeenCalledOnce();
    const closed = queue.close();
    await vi.advanceTimersByTimeAsync(20);
    await closed;
    expect(client.quit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
