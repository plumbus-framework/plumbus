import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from 'redis';
import { createRedisQueue, RedisQueueScripts, type RedisClient } from '../queue.js';
import { tryCreateRedisClient } from '../../runtime/queue-factory.js';

let process: ChildProcess;
let port: number;
let client: RedisClient;
let admin: ReturnType<typeof createClient>;
beforeAll(async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process = spawn(
    'redis-server',
    ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', () => reject(new Error('Redis test server exited')));
    process.stdout?.on('data', (data) => {
      if (String(data).includes('Ready to accept connections')) resolve();
    });
  });
  client = await tryCreateRedisClient({ host: '127.0.0.1', port }, {});
  admin = createClient({ url: `redis://127.0.0.1:${port}` });
  admin.on('error', () => {});
  await admin.connect();
});
afterAll(async () => {
  await client?.quit();
  await admin?.quit();
  if (process && process.exitCode === null) {
    await new Promise<void>((resolve) => {
      process.once('exit', () => resolve());
      process.kill('SIGTERM');
    });
  }
});
function envelope(id = crypto.randomUUID()) {
  return {
    id,
    eventType: 'test.event',
    version: '1',
    occurredAt: new Date(),
    actor: 'test',
    correlationId: id,
    payload: {},
  };
}

describe('Redis atomic queue transitions', () => {
  it.each([
    false,
    true,
  ])('recovers stale and legacy entries once across concurrent reclaimers (legacy=%s)', async (legacy) => {
    const prefix = crypto.randomUUID();
    const raw = JSON.stringify(envelope());
    const entry = legacy ? raw : JSON.stringify({ envelope: raw, dequeuedAt: Date.now() - 60000 });
    await client.lpush(`${prefix}:processing`, entry);
    const second = await tryCreateRedisClient({ host: '127.0.0.1', port }, {});
    try {
      const results = await Promise.all(
        [client, second].map((c) =>
          c.eval?.(RedisQueueScripts.reclaim, {
            keys: [`${prefix}:processing`, `${prefix}:pending`],
            arguments: ['1000'],
          }),
        ),
      );
      expect(results.sort()).toEqual([0, 1]);
      expect(await client.lrange(`${prefix}:pending`, 0, -1)).toEqual([raw]);
      expect(await client.lrange(`${prefix}:processing`, 0, -1)).toEqual([]);
    } finally {
      await second.quit();
    }
  });
  it('keeps the processing entry when the destination cannot accept a transfer', async () => {
    const prefix = crypto.randomUUID();
    await client.lpush(`${prefix}:processing`, 'entry');
    await admin.set(`${prefix}:pending`, 'wrong-type');
    await expect(
      client.eval?.(RedisQueueScripts.transfer, {
        keys: [`${prefix}:processing`, `${prefix}:pending`],
        arguments: ['entry', 'envelope'],
      }),
    ).rejects.toThrow();
    expect(await client.lrange(`${prefix}:processing`, 0, -1)).toEqual(['entry']);
  });
  it('does not reclaim an acknowledged entry', async () => {
    const prefix = crypto.randomUUID();
    await client.lpush(`${prefix}:processing`, 'entry');
    await client.lrem(`${prefix}:processing`, 1, 'entry');
    expect(
      await client.eval?.(RedisQueueScripts.transfer, {
        keys: [`${prefix}:processing`, `${prefix}:pending`],
        arguments: ['entry', 'envelope'],
      }),
    ).toBe(0);
    expect(await client.lrange(`${prefix}:pending`, 0, -1)).toEqual([]);
  });
  it('quarantines invalid envelopes without calling subscribers', async () => {
    const prefix = crypto.randomUUID();
    const handler = vi.fn(async () => {});
    const queue = createRedisQueue(client, {
      prefix,
      ownsClient: false,
      pollIntervalMs: 5,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    queue.subscribe(handler);
    try {
      await client.lpush(`${prefix}:pending`, '{bad');
      await vi.waitFor(async () =>
        expect(await client.lrange(`${prefix}:invalid`, 0, -1)).toEqual(['{bad']),
      );
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await queue.close();
    }
  });
  it('retains messages if any subscriber rejects', async () => {
    const prefix = crypto.randomUUID();
    const queue = createRedisQueue(client, {
      prefix,
      ownsClient: false,
      pollIntervalMs: 5,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const failed = vi.fn(async () => {
      throw new Error('sensitive payload');
    });
    queue.subscribe(async () => {});
    queue.subscribe(failed);
    try {
      await queue.publish(envelope());
      await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
      expect(await client.lrange(`${prefix}:processing`, 0, -1)).toHaveLength(1);
    } finally {
      await queue.close();
    }
  });
  it('renews active visibility while another worker polls', async () => {
    const prefix = crypto.randomUUID();
    const options = {
      prefix,
      ownsClient: false,
      pollIntervalMs: 5,
      reclaimIntervalMs: 5,
      visibilityTimeoutSec: 0.09,
    };
    const first = createRedisQueue(client, options);
    const second = createRedisQueue(client, options);
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    first.subscribe(handler);
    try {
      await first.publish(envelope());
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      second.subscribe(handler);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(handler).toHaveBeenCalledOnce();
      expect(await client.lrange(`${prefix}:processing`, 0, -1)).toEqual([]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
  it('distinguishes authentication and malformed connection configuration', async () => {
    await (admin as any).sendCommand(['CONFIG', 'SET', 'requirepass', 'test-password']);
    try {
      await expect(
        tryCreateRedisClient(
          { host: '127.0.0.1', port, password: 'wrong', startupTimeoutMs: 150 },
          {},
          () => {},
        ),
      ).rejects.toMatchObject({ metadata: { reason: 'redis_authentication' } });
    } finally {
      await (admin as any).sendCommand(['CONFIG', 'SET', 'requirepass', '']);
    }
    await expect(
      tryCreateRedisClient({ host: '127.0.0.1', port, url: 'http://invalid' }, {}, () => {}),
    ).rejects.toMatchObject({ metadata: { reason: 'redis_configuration' } });
  });
  it('handles a runtime disconnect and reconnects without changing backends', async () => {
    const warning = vi.fn();
    const connection = await tryCreateRedisClient({ host: '127.0.0.1', port }, {}, warning);
    try {
      await (admin as any).sendCommand(['CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'yes']);
      await vi.waitFor(() => expect(warning).toHaveBeenCalled());
      await vi.waitFor(async () => expect(await connection.ping?.()).toBe('PONG'));
    } finally {
      await connection.quit();
    }
  });
  it('rejects Redis startup rather than falling back', async () => {
    await expect(
      tryCreateRedisClient({ host: '127.0.0.1', port: 1, startupTimeoutMs: 50 }, {}, () => {}),
    ).rejects.toMatchObject({ metadata: { reason: 'redis_startup_timeout' } });
  });
});
