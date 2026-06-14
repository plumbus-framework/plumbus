import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '../../types/event.js';
import { createRedisQueue, type RedisClient } from '../queue.js';

function makeEnvelope(id: string): EventEnvelope {
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

describe('createRedisQueue visibility recovery', () => {
  it('requeues legacy processing entries with dequeuedAt 0', async () => {
    const pending: string[] = [];
    const processing: string[] = [];
    const staleEnvelope = JSON.stringify(makeEnvelope('legacy-1'));
    processing.push(staleEnvelope);

    const client: RedisClient = {
      lpush: vi.fn(async (key, ...values) => {
        if (key.endsWith(':pending')) pending.push(...values);
        return values.length;
      }),
      rpoplpush: vi.fn(async () => null),
      lrem: vi.fn(async (_key, _count, value) => {
        const idx = processing.indexOf(value);
        if (idx !== -1) processing.splice(idx, 1);
        return 1;
      }),
      lrange: vi.fn(async (key) => (key.endsWith(':processing') ? [...processing] : [])),
      quit: vi.fn(async () => {}),
    };

    const queue = createRedisQueue(client, {
      prefix: 'test',
      pollIntervalMs: 50,
      visibilityTimeoutSec: 1,
    });

    queue.subscribe(async () => {});

    await new Promise((r) => setTimeout(r, 120));
    expect(pending.length).toBeGreaterThan(0);
    await queue.close();
  });

  it('requeues stale processing entries after visibility timeout', async () => {
    const pending: string[] = [];
    const processing: string[] = [];
    const staleEnvelope = JSON.stringify(makeEnvelope('stale-1'));
    const wrappedStale = JSON.stringify({
      envelope: staleEnvelope,
      dequeuedAt: Date.now() - 60_000,
    });
    processing.push(wrappedStale);

    const client: RedisClient = {
      lpush: vi.fn(async (key, ...values) => {
        if (key.endsWith(':pending')) pending.push(...values);
        return values.length;
      }),
      rpoplpush: vi.fn(async () => null),
      lrem: vi.fn(async (_key, _count, value) => {
        const idx = processing.indexOf(value);
        if (idx !== -1) processing.splice(idx, 1);
        return 1;
      }),
      lrange: vi.fn(async (key) => (key.endsWith(':processing') ? [...processing] : [])),
      quit: vi.fn(async () => {}),
    };

    const queue = createRedisQueue(client, {
      prefix: 'test',
      pollIntervalMs: 50,
      visibilityTimeoutSec: 1,
    });

    const received: string[] = [];
    queue.subscribe(async (e) => {
      received.push(e.id);
    });

    await new Promise((r) => setTimeout(r, 120));
    expect(pending.length).toBeGreaterThan(0);
    await queue.close();
  });
});
