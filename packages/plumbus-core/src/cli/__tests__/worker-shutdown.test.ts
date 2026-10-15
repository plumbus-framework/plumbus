import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../discover.js', () => ({
  discoverResources: vi.fn(async () => ({
    capabilities: [],
    entities: [],
    flows: [],
    events: [],
    prompts: [],
  })),
}));

const order: string[] = [];

vi.mock('../../runtime/queue-factory.js', () => ({
  resolveRuntimeQueues: vi.fn(async () => ({
    events: {},
    flows: {},
    jobs: {},
    backend: 'memory',
    isDurable: false,
    close: vi.fn(async () => {
      order.push('queues');
    }),
  })),
  shouldUseRedisBackend: vi.fn(() => false),
}));

const poolStop = vi.fn(async (_options?: { deadlineAt?: number }) => {
  order.push('workers');
});
vi.mock('../../runtime/start-worker-pool.js', () => ({
  startWorkerPool: vi.fn(async () => {
    order.push('pool-started');
    return { stop: poolStop, flowCycleInFlight: false };
  }),
}));

vi.mock('../../runtime/worker-health.js', () => ({
  createWorkerHealthServer: vi.fn(() => ({
    start: vi.fn(async () => 'http://0.0.0.0:9100'),
    stop: vi.fn(async () => {
      order.push('health');
    }),
    markShuttingDown: () => order.push('ready-off'),
  })),
}));

const onBoot = vi.fn(async (_context: Record<string, unknown>) => {
  order.push('boot');
});
vi.mock('../../runtime/load-extensions.js', () => ({
  loadServerExtensions: vi.fn(async () => ({
    onBoot,
    onShutdown: async (context: { signal?: string }) => {
      order.push(`hook:${context.signal}`);
    },
  })),
}));

import { startWorkerProcess } from '../commands/worker.js';

const processEvents = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
let listenersBefore = new Map<string, ((...args: never) => unknown)[]>();

describe('plumbus worker shutdown', () => {
  beforeEach(() => {
    order.length = 0;
    poolStop.mockClear();
    onBoot.mockClear();
    listenersBefore = new Map(processEvents.map((event) => [event, [...process.listeners(event)]]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.PLUMBUS_SHUTDOWN_TIMEOUT_MS = '3000';
  });

  afterEach(() => {
    for (const event of processEvents) {
      const before = listenersBefore.get(event) ?? [];
      for (const listener of process.listeners(event)) {
        if (!before.includes(listener)) process.removeListener(event, listener as never);
      }
    }
    delete process.env.PLUMBUS_SHUTDOWN_TIMEOUT_MS;
  });

  it('turns readiness off, stops the pool with a deadline, runs onShutdown, then queues, DB, health', async () => {
    const end = vi.fn(async () => {
      order.push('database');
    });
    const { shutdown } = await startWorkerProcess({
      healthPort: '9100',
      connection: { db: {} as never, sql: { end } as never },
    });
    // The app booted before the pool started: a worker never calls onRoutesRegistered.
    expect(order).toEqual(['boot', 'pool-started']);
    expect(onBoot).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'worker', role: 'worker', servesHttp: false }),
    );
    order.length = 0;
    const before = Date.now();
    await shutdown('SIGTERM');

    expect(order).toEqual(['ready-off', 'workers', 'hook:SIGTERM', 'queues', 'database', 'health']);
    const deadlineAt = poolStop.mock.calls[0]?.[0]?.deadlineAt ?? 0;
    expect(deadlineAt).toBeGreaterThan(before);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 3_000);
  });
});
