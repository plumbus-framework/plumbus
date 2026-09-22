import { describe, expect, it, vi } from 'vitest';
import { createRedisQueue, type RedisClient } from '../../events/queue.js';

describe('createRedisQueue shared client close', () => {
  it('does not quit Redis client when ownsClient is false', async () => {
    const quit = vi.fn().mockResolvedValue(undefined);
    const client: RedisClient = {
      lpush: vi.fn().mockResolvedValue(1),
      rpoplpush: vi.fn().mockResolvedValue(null),
      lrem: vi.fn().mockResolvedValue(0),
      lrange: vi.fn().mockResolvedValue([]),
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
      quit,
    };

    const queue = createRedisQueue(client, { prefix: 'test' });
    await queue.close();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
