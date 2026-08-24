import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';
import { listSideEffects, loadExecutionState } from '../../durable/postgres-persist.js';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { FlowStepType } from '../../types/enums.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { FlowStatus } from '../state-machine.js';

function makeFlow() {
  return defineFlow({
    name: 'durable-demo',
    domain: 'durable',
    input: z.object({ n: z.number() }),
    steps: [
      { name: 'alpha', type: FlowStepType.Capability, capability: 'durable.noop' },
      { name: 'beta', type: FlowStepType.Capability, capability: 'durable.noop' },
    ],
  });
}

describe('flow engine spine dispatch on two databases', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('starts on the tenant db, claims from the spine, and runs the existing step machine', async () => {
    harness = await createDurableTestHarness();
    const registry = new FlowRegistry();
    registry.register(makeFlow());
    const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
      coreSchema: harness.coreSchema,
    });

    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
      spineDispatch: {
        db: harness.spineDb,
        resolver,
        coreSchema: harness.coreSchema,
      },
      flowLeaseDurationMs: 30_000,
    });

    const started = await engine.start(
      'durable-demo',
      { n: 1 },
      { userId: 'tester', roles: ['system'], scopes: [], provider: 'test', tenantId: 'tenant-a' },
    );
    expect(started.status).toBe(FlowStatus.Created);

    const accepted = await loadExecutionState(harness.tenantDb, started.id, harness.coreSchema);
    expect(accepted?.revision).toBe(1);
    expect(accepted?.tenantRef).toBe('tenant-a');

    const claimed = await engine.claimNext(5);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(started.id);

    const ctx = {
      auth: {
        userId: 'system',
        roles: ['system'],
        scopes: [],
        provider: 'worker',
        tenantId: 'tenant-a',
      },
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
    const afterFirst = await engine.runNext(started.id, ctx);
    expect([FlowStatus.Running, FlowStatus.Completed]).toContain(afterFirst.status);

    const effects = await listSideEffects(harness.tenantDb, harness.coreSchema);
    expect(effects.length).toBeGreaterThanOrEqual(1);
    expect(new Set(effects).size).toBe(effects.length);
  });
});
