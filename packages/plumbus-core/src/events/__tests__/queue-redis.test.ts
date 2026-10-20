import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from 'redis';
import { DataInternalError } from '../../errors/index.js';
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
  it.each([
    { visibilityTimeoutSec: 0.09, leaseDurationMs: 90 },
    { visibilityTimeoutSec: 1, leaseDurationMs: 1000 },
    { visibilityTimeoutSec: 60, leaseDurationMs: 60000 },
    { visibilityTimeoutSec: 10 * 365 * 24 * 60 * 60, leaseDurationMs: 30000 },
  ])('protects active delivery from a shorter-timeout reclaimer (owner timeout=$visibilityTimeoutSec)', async ({
    visibilityTimeoutSec,
    leaseDurationMs,
  }) => {
    const prefix = crypto.randomUUID();
    const options = {
      prefix,
      ownsClient: false,
      pollIntervalMs: 5,
      reclaimIntervalMs: 5,
      visibilityTimeoutSec: 0.09,
    };
    const ownerEval = vi.fn<NonNullable<RedisClient['eval']>>(async (script, args) =>
      client.eval?.(script, args),
    );
    const first = createRedisQueue(
      { ...client, eval: ownerEval },
      { ...options, visibilityTimeoutSec },
    );
    const second = createRedisQueue(client, options);
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    first.subscribe(handler);
    try {
      await first.publish(envelope());
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      const entries = await client.lrange(`${prefix}:processing`, 0, -1);
      expect(JSON.parse(entries[0] ?? '{}')).toMatchObject({
        leaseDurationMs,
      });
      second.subscribe(handler);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(handler).toHaveBeenCalledOnce();
      expect(await client.lrange(`${prefix}:processing`, 0, -1)).toEqual([]);
      if (visibilityTimeoutSec > 30) {
        expect(ownerEval).not.toHaveBeenCalledWith(RedisQueueScripts.renew, expect.anything());
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
  it('honors an existing lease before allowing concurrent reclaimers to recover it', async () => {
    const prefix = crypto.randomUUID();
    const raw = JSON.stringify(envelope());
    const entry = {
      envelope: raw,
      deliveryId: 'old-owner',
      dequeuedAt: Date.now() - 200,
      leaseDurationMs: 1000,
    };
    const active = JSON.stringify(entry);
    await client.lpush(`${prefix}:processing`, active);
    const options = {
      keys: [`${prefix}:processing`, `${prefix}:pending`],
      arguments: ['90'],
    };
    expect(await client.eval?.(RedisQueueScripts.reclaim, options)).toBe(0);
    expect(await client.lrange(`${prefix}:processing`, 0, -1)).toEqual([active]);

    const expired = JSON.stringify({ ...entry, dequeuedAt: Date.now() - 2000 });
    await admin.lSet(`${prefix}:processing`, 0, expired);
    const other = await tryCreateRedisClient({ host: '127.0.0.1', port }, {});
    try {
      const results = await Promise.all(
        [client, other].map((connection) => connection.eval?.(RedisQueueScripts.reclaim, options)),
      );
      expect(results.sort()).toEqual([0, 1]);
      expect(await client.lrange(`${prefix}:pending`, 0, -1)).toEqual([raw]);
      const newOwner = await client.eval?.(RedisQueueScripts.claim, {
        keys: [`${prefix}:pending`, `${prefix}:processing`],
        arguments: ['0', 'new-owner', '90'],
      });
      expect(
        await client.eval?.(RedisQueueScripts.renew, {
          keys: [`${prefix}:processing`],
          arguments: [expired, '1000'],
        }),
      ).toBe(0);
      expect(await client.lrem(`${prefix}:processing`, 1, expired)).toBe(0);
      expect(await client.lrange(`${prefix}:processing`, 0, -1)).toEqual([newOwner]);
    } finally {
      await other.quit();
    }
  });

  it('renews the configured lease using Redis time', async () => {
    const prefix = crypto.randomUUID();
    const raw = JSON.stringify(envelope());
    const previous = JSON.stringify({
      envelope: raw,
      deliveryId: 'owner',
      dequeuedAt: Date.now() - 200,
      leaseDurationMs: 1000,
    });
    await client.lpush(`${prefix}:processing`, previous);
    const beforeRenewal = Date.now();
    const renewed = await client.eval?.(RedisQueueScripts.renew, {
      keys: [`${prefix}:processing`],
      arguments: [previous, '1000'],
    });
    if (typeof renewed !== 'string') throw new DataInternalError('Expected renewed delivery');
    const decoded = JSON.parse(renewed);
    expect(decoded).toMatchObject({ envelope: raw, deliveryId: 'owner', leaseDurationMs: 1000 });
    expect(decoded.dequeuedAt).toBeGreaterThanOrEqual(beforeRenewal);
    expect(
      await client.eval?.(RedisQueueScripts.reclaim, {
        keys: [`${prefix}:processing`, `${prefix}:pending`],
        arguments: ['90'],
      }),
    ).toBe(0);
    expect(await client.lrange(`${prefix}:processing`, 0, -1)).toEqual([renewed]);
  });

  it.each([
    1000, 30000, 60000, 3600000,
  ])('preserves configured recovery timing for matching workers (visibilityMs=%s)', async (visibilityMs) => {
    const prefix = crypto.randomUUID();
    const raw = JSON.stringify(envelope());
    await client.lpush(`${prefix}:pending`, raw);
    const claimed = await client.eval?.(RedisQueueScripts.claim, {
      keys: [`${prefix}:pending`, `${prefix}:processing`],
      arguments: ['0', 'owner', String(visibilityMs)],
    });
    if (typeof claimed !== 'string') throw new DataInternalError('Expected claimed delivery');
    const decoded = JSON.parse(claimed);
    expect(decoded.leaseDurationMs).toBe(visibilityMs);
    const reclaimOptions = {
      keys: [`${prefix}:processing`, `${prefix}:pending`],
      arguments: [String(visibilityMs)],
    };
    await admin.lSet(
      `${prefix}:processing`,
      0,
      JSON.stringify({
        ...decoded,
        dequeuedAt: Date.now() - visibilityMs + 200,
      }),
    );
    expect(await client.eval?.(RedisQueueScripts.reclaim, reclaimOptions)).toBe(0);
    await admin.lSet(
      `${prefix}:processing`,
      0,
      JSON.stringify({
        ...decoded,
        dequeuedAt: Date.now() - visibilityMs - 200,
      }),
    );
    expect(await client.eval?.(RedisQueueScripts.reclaim, reclaimOptions)).toBe(1);
    expect(await client.lrange(`${prefix}:pending`, 0, -1)).toEqual([raw]);
  });

  it.each([
    30000,
    10 * 365 * 24 * 60 * 60 * 1000,
  ])('recovers an overflowing lease with the default duration while preserving reclaimer thresholds (lease=%s)', async (leaseDurationMs) => {
    const prefix = crypto.randomUUID();
    const raw = JSON.stringify(envelope());
    await client.lpush(
      `${prefix}:processing`,
      JSON.stringify({
        envelope: raw,
        dequeuedAt: Date.now() - 31000,
        leaseDurationMs,
      }),
    );
    const keys = [`${prefix}:processing`, `${prefix}:pending`];
    expect(
      await client.eval?.(RedisQueueScripts.reclaim, {
        keys,
        arguments: [String(10 * 365 * 24 * 60 * 60 * 1000)],
      }),
    ).toBe(0);
    expect(
      await client.eval?.(RedisQueueScripts.reclaim, {
        keys,
        arguments: ['90'],
      }),
    ).toBe(1);
    expect(await client.lrange(`${prefix}:pending`, 0, -1)).toEqual([raw]);
  });

  it('recovers a stopped long-timeout owner after its bounded lease expires', async () => {
    const prefix = crypto.randomUUID();
    const first = createRedisQueue(client, {
      prefix,
      ownsClient: false,
      pollIntervalMs: 5,
      visibilityTimeoutSec: 10 * 365 * 24 * 60 * 60,
      shutdownTimeoutMs: 10,
    });
    const second = createRedisQueue(client, {
      prefix,
      ownsClient: false,
      pollIntervalMs: 5,
      visibilityTimeoutSec: 0.09,
    });
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stoppedHandler = vi.fn(() => pending);
    const recoveredHandler = vi.fn(async () => {});
    first.subscribe(stoppedHandler);
    try {
      await first.publish(envelope());
      await vi.waitFor(() => expect(stoppedHandler).toHaveBeenCalledOnce());
      await first.close();
      const entries = await client.lrange(`${prefix}:processing`, 0, -1);
      const abandoned = JSON.parse(entries[0] ?? '{}');
      expect(abandoned.leaseDurationMs).toBe(30000);
      // Simulate the lease elapsing without a thirty-second wall-clock wait.
      await admin.lSet(
        `${prefix}:processing`,
        0,
        JSON.stringify({
          ...abandoned,
          dequeuedAt: Date.now() - 31000,
        }),
      );
      second.subscribe(recoveredHandler);
      await vi.waitFor(() => expect(recoveredHandler).toHaveBeenCalledOnce());
      expect(await client.lrange(`${prefix}:processing`, 0, -1)).toEqual([]);
      expect(stoppedHandler).toHaveBeenCalledOnce();
    } finally {
      finish();
      await Promise.all([first.close(), second.close()]);
    }
  });

  it.each([
    'invalid',
    -1,
    null,
  ])('recovers entries with invalid lease metadata (%s)', async (leaseDurationMs) => {
    const prefix = crypto.randomUUID();
    const raw = JSON.stringify(envelope());
    await client.lpush(
      `${prefix}:processing`,
      JSON.stringify({
        envelope: raw,
        dequeuedAt: Date.now() - 1000,
        leaseDurationMs,
      }),
    );
    expect(
      await client.eval?.(RedisQueueScripts.reclaim, {
        keys: [`${prefix}:processing`, `${prefix}:pending`],
        arguments: ['90'],
      }),
    ).toBe(1);
    expect(await client.lrange(`${prefix}:pending`, 0, -1)).toEqual([raw]);
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
