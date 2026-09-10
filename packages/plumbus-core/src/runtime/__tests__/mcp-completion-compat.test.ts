import { expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../../execution/index.js';
import { EntityRegistry } from '../../data/index.js';
import { EventRegistry, ConsumerRegistry } from '../../events/index.js';
import { FlowRegistry } from '../../flows/index.js';
import { loadConfig } from '../../config/index.js';
import { startWorkerPool } from '../start-worker-pool.js';

const capture = vi.hoisted(() => ({ poolConfig: undefined as any, contexts: [] as any[] }));
vi.mock('../../worker/bootstrap.js', () => ({
  createWorkerPool: (config: unknown) => {
    capture.poolConfig = config;
    return { start: async () => {}, stop: async () => {} };
  },
}));
vi.mock('@plumbus/mcp', () => ({
  createMcpJobCompletionSync: (deps: any) => {
    // Simulate the previously published overload: it accepts a deps object only.
    expect(typeof deps).toBe('object');
    capture.contexts.push(deps);
    return async () => {};
  },
}));

it('supports the old MCP deps-object API with fresh tenant-bound repositories per completion', async () => {
  capture.contexts.length = 0;
  const entities = new EntityRegistry();
  const bindings: any[] = [];
  vi.spyOn(entities, 'createDataService').mockImplementation((options) => {
    bindings.push(options);
    return {};
  });
  await startWorkerPool({
    config: loadConfig({ env: {} }),
    db: {} as never,
    entities,
    capabilities: new CapabilityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    queues: { events: {}, jobs: {}, flows: {}, isDurable: false, close: async () => {} } as never,
  });
  await capture.poolConfig.onMcpJobComplete('job-a', 'completed', {}, undefined, 'tenant-a');
  await capture.poolConfig.onMcpJobComplete('job-b', 'completed', {}, undefined, null);
  expect(capture.contexts[0].auth.tenantId).toBe('tenant-a');
  expect(capture.contexts[1].auth.tenantId).toBeUndefined();
  expect(bindings[0]).toMatchObject({ auth: { tenantId: 'tenant-a' }, bypassTenantScope: false });
  expect(bindings[1]).toMatchObject({ auth: { tenantId: undefined }, bypassTenantScope: true });
});
