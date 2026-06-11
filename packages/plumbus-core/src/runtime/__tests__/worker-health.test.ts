import { describe, expect, it, vi } from 'vitest';
import { createWorkerHealthServer } from '../worker-health.js';

describe('createWorkerHealthServer /ready', () => {
  it('pings Redis when queues are durable', async () => {
    const pingRedis = vi.fn().mockResolvedValue(undefined);
    const db = {
      execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as never;

    const health = createWorkerHealthServer({
      port: 0,
      db,
      queues: {
        isDurable: true,
        pingRedis,
      } as never,
    });

    const address = await health.start();
    const port = Number(address.split(':').pop());
    const response = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(response.status).toBe(200);
    expect(pingRedis).toHaveBeenCalled();
    await health.stop();
  });

  it('returns 503 when Redis ping fails', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as never;

    const health = createWorkerHealthServer({
      port: 0,
      db,
      queues: {
        isDurable: true,
        pingRedis: vi.fn().mockRejectedValue(new Error('Redis down')),
      } as never,
    });

    const address = await health.start();
    const port = Number(address.split(':').pop());
    const response = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(response.status).toBe(503);
    await health.stop();
  });
});
