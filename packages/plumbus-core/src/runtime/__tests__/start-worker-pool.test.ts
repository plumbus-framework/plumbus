// ── What `plumbus worker` hands the pool from the host's server extensions ──
//
// With a host `dataPlaneResolver` the pool gets the resolver family (and no caller-built
// data service, which the pool would refuse beside a resolver); without one it gets the
// classic data service on the boot database and the scheduler planes, if any.

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

function baseOptions() {
  return {
    config: loadConfig({ env: {} }),
    db: {} as never,
    entities: new EntityRegistry(),
    capabilities: new CapabilityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    queues: { events: {}, jobs: {}, flows: {}, isDurable: false, close: async () => {} } as never,
  };
}

it('hands the pool the resolver family, the unit data-plane policy, and no data service', async () => {
  const dataPlaneResolver = { resolve: vi.fn() };
  const listTenantRefs = async () => ['tenant-a'];
  const resolveTenantRef = (auth: { tenantId?: string }) => auth.tenantId;
  await startWorkerPool({
    ...baseOptions(),
    extensions: {
      dataPlaneResolver,
      listTenantRefs,
      untenantedDataPlane: 'control-plane',
      resolveTenantRef,
      workerDataPlane: 'control-plane',
      schedulePlanes: { resolver: dataPlaneResolver, listTenantRefs },
    } as never,
  });
  expect(capture.poolConfig).toMatchObject({
    dataPlaneResolver,
    listTenantRefs,
    untenantedDataPlane: 'control-plane',
    resolveTenantRef,
    unitDataPlane: 'control-plane',
  });
  expect('createDataService' in capture.poolConfig).toBe(false);
  expect('schedulePlanes' in capture.poolConfig).toBe(false);
});

it('leaves the unit data-plane policy off when the host does not export one', async () => {
  await startWorkerPool({
    ...baseOptions(),
    extensions: { dataPlaneResolver: { resolve: vi.fn() } } as never,
  });
  expect('unitDataPlane' in capture.poolConfig).toBe(false);
  expect('createDataService' in capture.poolConfig).toBe(false);
});

it('builds the classic data service on the boot database without a resolver', async () => {
  const listTenantRefs = async () => ['tenant-a'];
  const schedulePlanes = { resolver: { resolve: vi.fn() }, listTenantRefs };
  await startWorkerPool({ ...baseOptions(), extensions: { schedulePlanes } as never });
  expect(typeof capture.poolConfig.createDataService).toBe('function');
  expect(capture.poolConfig.schedulePlanes).toBe(schedulePlanes);
  expect('dataPlaneResolver' in capture.poolConfig).toBe(false);
});
