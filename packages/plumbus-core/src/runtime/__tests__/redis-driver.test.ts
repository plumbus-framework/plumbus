import { describe, expect, it, vi } from 'vitest';
vi.mock('redis', () => {
  throw new Error('driver missing');
});
import { resolveRuntimeQueues } from '../queue-factory.js';
import { loadConfig } from '../../config/index.js';

describe('Redis backend selection', () => {
  it('rejects a missing driver instead of falling back to memory', async () => {
    await expect(
      resolveRuntimeQueues(loadConfig({ env: {}, queue: { backend: 'redis' } })),
    ).rejects.toMatchObject({ metadata: { reason: 'redis_driver_missing' } });
  });
  it('preserves deliberately selected memory and the development override', async () => {
    for (const config of [{ backend: 'memory' as const }, { backend: 'redis' as const }]) {
      const queues = await resolveRuntimeQueues(loadConfig({ env: {}, queue: config }), {
        preferInMemory: true,
      });
      expect(queues.backend).toBe('memory');
      await queues.close();
    }
  });
});
