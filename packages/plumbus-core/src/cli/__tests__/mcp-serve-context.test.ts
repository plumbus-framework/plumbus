import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRuntimeQueues } = vi.hoisted(() => ({
  resolveRuntimeQueues: vi.fn(),
}));

vi.mock('../../runtime/queue-factory.js', () => ({
  resolveRuntimeQueues,
}));

vi.mock('../discover.js', () => ({
  discoverResources: vi.fn(async () => ({
    capabilities: [],
    entities: [],
    flows: [],
    events: [],
    translations: [],
  })),
}));

vi.mock('../../config/loader.js', () => ({
  loadConfig: vi.fn(() => ({
    environment: 'development',
    database: { host: 'localhost', port: 5432, database: 'test', user: 'u', password: 'p' },
    queue: { host: 'localhost', port: 6379 },
    auth: { provider: 'jwt', secret: 'development-secret-placeholder-32chars-min' },
  })),
}));

vi.mock('../../data/connection.js', () => ({
  resolveDatabaseConnection: vi.fn(async () => ({
    db: {},
    sql: null,
  })),
  closeDatabaseConnection: vi.fn(async () => {}),
}));

import { buildMcpServeContext } from '../mcp-serve-context.js';

describe('buildMcpServeContext jobQueue wiring', () => {
  beforeEach(() => {
    resolveRuntimeQueues.mockReset();
  });

  it('omits jobQueue when queues are not durable', async () => {
    const close = vi.fn(async () => {});
    resolveRuntimeQueues.mockResolvedValue({
      jobs: { publish: vi.fn() },
      isDurable: false,
      close,
    });

    const ctx = await buildMcpServeContext();

    expect(ctx.jobQueue).toBeUndefined();
    expect(resolveRuntimeQueues).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'development' }),
    );
    expect(resolveRuntimeQueues.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('passes jobQueue when queues are durable (Redis)', async () => {
    const jobsQueue = { publish: vi.fn() };
    resolveRuntimeQueues.mockResolvedValue({
      jobs: jobsQueue,
      isDurable: true,
      close: vi.fn(async () => {}),
    });

    const ctx = await buildMcpServeContext();

    expect(ctx.jobQueue).toBe(jobsQueue);
  });
});
