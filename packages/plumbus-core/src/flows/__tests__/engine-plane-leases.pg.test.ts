// The flow engine under spine dispatch with a pooled resolver: an operation on an execution
// never uses a plane handle the resolver closed since (it resolves the plane again by the
// execution's tenant route), and a claimed execution's plane stays open while the runner
// holds it, even when it is invalidated meanwhile.

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';
import { openDataPlaneConnection } from '../../tenancy/data-plane-connection.js';
import { createPooledDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { FlowStepType } from '../../types/enums.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { FlowStatus } from '../state-machine.js';

const auth = {
  userId: 'tester',
  roles: ['system'],
  scopes: [],
  provider: 'test',
  tenantId: 'tenant-a',
};

const ctx = {
  auth: { ...auth, userId: 'system', provider: 'worker' },
  data: {},
  events: { emit: async () => undefined, emitMany: async () => undefined },
  flows: {
    start: async () => ({}),
    resume: async () => undefined,
    cancel: async () => undefined,
    status: async () => ({}),
  },
  ai: {},
  audit: { record: async () => undefined },
  errors: {},
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  time: { now: () => new Date() },
  config: {},
  security: {},
  translations: { locale: 'en', t: (key: string) => key },
} as never;

describe('flow engine with a pooled, leased resolver', () => {
  let harness: DurableTestHarness;
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const close of closers.reverse()) await close();
    await harness?.close();
  });

  async function setup() {
    harness ??= await createDurableTestHarness();
    const resolver = createPooledDataPlaneResolver({
      cacheSize: 1,
      describe: async (tenantRef) =>
        tenantRef === 'tenant-a'
          ? { connectionInfo: harness.tenantName, coreSchema: harness.coreSchema }
          : undefined,
      connect: ({ descriptor }) =>
        openDataPlaneConnection({
          target: {
            host: harness.admin.host,
            port: harness.admin.port,
            database: descriptor.connectionInfo as string,
            user: harness.admin.user,
            password: harness.admin.password,
          },
          maxConnections: 2,
        }),
    });
    closers.push(() => resolver.close());
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'leased-demo',
        domain: 'durable',
        input: z.object({}),
        steps: [
          { name: 'alpha', type: FlowStepType.Capability, capability: 'durable.noop' },
          { name: 'beta', type: FlowStepType.Capability, capability: 'durable.noop' },
        ],
      }),
    );
    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
      spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
      flowLeaseDurationMs: 30_000,
    });
    return { resolver, engine };
  }

  it('reads an execution again after its plane was closed and reopened', async () => {
    const { resolver, engine } = await setup();
    const started = await engine.start('leased-demo', {}, auth);
    // The plane the engine placed the execution on is closed (nobody holds it).
    await resolver.invalidate('tenant-a');
    expect(resolver.stats()).toMatchObject({ cached: 0, leases: 0 });

    expect(await engine.status(started.id)).toMatchObject({
      id: started.id,
      status: FlowStatus.Created,
    });
    expect(await engine.getExecutionOwner(started.id)).toMatchObject({ tenantId: 'tenant-a' });
    expect(resolver.stats().leases).toBe(0);
  }, 60_000);

  it('holds a claimed execution’s plane for the drain, even across an invalidation', async () => {
    const { resolver, engine } = await setup();
    const started = await engine.start('leased-demo', {}, auth);
    const claimed = await engine.claimNext(5);
    expect(claimed.map((row) => row.id)).toContain(started.id);
    expect(resolver.stats().leases).toBe(0);

    const lease = await engine.acquireExecutionPlane(started.id);
    expect(lease).toBeDefined();
    expect(resolver.stats().leases).toBe(1);

    await resolver.invalidate('tenant-a');
    // Retired, not closed: the drain keeps running on it.
    expect(resolver.stats()).toMatchObject({ cached: 0, retired: 1 });
    const token = claimed.find((row) => row.id === started.id)?.leaseToken ?? undefined;
    let status = (await engine.runNext(started.id, ctx, token)).status;
    while (status === FlowStatus.Running) {
      status = (await engine.runNext(started.id, ctx, token)).status;
    }
    expect(status).toBe(FlowStatus.Completed);

    lease?.release();
    expect(resolver.stats()).toMatchObject({ retired: 0, leases: 0 });
  }, 60_000);
});
