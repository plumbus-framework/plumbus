import { expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { EntityRegistry } from '../../data/index.js';
import { ConsumerRegistry, EventRegistry } from '../../events/index.js';
import { CapabilityRegistry } from '../../execution/index.js';
import { FlowRegistry } from '../../flows/index.js';
import { startWorkerPool } from '../start-worker-pool.js';

const capture = vi.hoisted(() => ({ poolConfig: undefined as any }));
vi.mock('../../worker/bootstrap.js', () => ({
  createWorkerPool: (config: unknown) => {
    capture.poolConfig = config;
    return { start: async () => {}, stop: async () => {} };
  },
}));
vi.mock('@plumbus/mcp', () => ({
  createMcpJobCompletionSync: () => async () => {},
}));

it('forwards onCapabilityError from app/server.ts extensions to the worker pool', async () => {
  const onCapabilityError = vi.fn();
  await startWorkerPool({
    config: loadConfig({ env: {} }),
    db: {} as never,
    entities: new EntityRegistry(),
    capabilities: new CapabilityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    queues: { events: {}, jobs: {}, flows: {}, isDurable: false, close: async () => {} } as never,
    extensions: { onCapabilityError },
  });

  expect(capture.poolConfig.onCapabilityError).toBe(onCapabilityError);
});
