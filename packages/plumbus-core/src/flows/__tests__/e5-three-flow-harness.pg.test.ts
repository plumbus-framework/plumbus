// E5 three-flow compile pilot on the two-DB harness.
// Fixture names are opaque examples (domain-agnostic).

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionRiskTier } from '../../approvals/action-risk.js';
import { createMemoryApprovalStore } from '../../approvals/memory-store.js';
import { createApprovalService } from '../../approvals/service.js';
import { defineFlow } from '../../define/defineFlow.js';
import { DURABLE_TEST_DB_PATTERN } from '../../durable/apply-ddl.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { FlowStepType } from '../../types/enums.js';
import type { FlowDefinition } from '../../types/flow.js';
import { compileFlowDefinition } from '../compile-flow.js';
import { CompiledFlowRegistry } from '../compiled-registry.js';
import { DEFINITION_STRATEGY_NOT_SUPPORTED } from '../definition-strategy.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { flowExecutionsTable } from '../schema.js';
import { FlowStatus } from '../state-machine.js';

const TENANT = 'tenant-e5';

function humanAuth() {
  return {
    userId: 'reviewer-1',
    tenantId: TENANT,
    roles: ['reviewer'],
    scopes: [],
    provider: 'oidc',
  };
}

function workerCtx(): never {
  return {
    auth: { userId: 'system', tenantId: TENANT, roles: ['system'], scopes: [], provider: 'worker' },
    data: {},
    events: { emit: async () => undefined, emitMany: async () => undefined },
    flows: {
      start: async () => ({ id: '', flowName: '', status: FlowStatus.Created }),
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
}

function flowA() {
  return defineFlow({
    name: 'flow-a',
    domain: 'example',
    input: z.object({ orderId: z.string() }),
    steps: [
      { name: 'accept', type: FlowStepType.Capability, capability: 'example.accept' },
      { name: 'queue', type: FlowStepType.Capability, capability: 'example.queue' },
    ],
  });
}

function flowB() {
  return defineFlow({
    name: 'flow-b',
    domain: 'example',
    input: z.object({ orderId: z.string() }),
    steps: [
      {
        name: 'route',
        type: FlowStepType.ApprovalOutcome,
        outcomes: { approved: 'record', rejected: 'record' },
      },
      { name: 'record', type: FlowStepType.Capability, capability: 'example.record' },
    ],
  });
}

function flowCV1() {
  return defineFlow({
    name: 'flow-c',
    domain: 'example',
    input: z.object({ orderId: z.string() }),
    steps: [
      { name: 'assemble', type: FlowStepType.Capability, capability: 'example.assemble' },
      {
        name: 'publish-original',
        type: FlowStepType.Capability,
        capability: 'example.publish-original',
      },
    ],
  });
}

function flowCV2() {
  return defineFlow({
    name: 'flow-c',
    domain: 'example',
    input: z.object({ orderId: z.string() }),
    steps: [
      { name: 'assemble', type: FlowStepType.Capability, capability: 'example.assemble' },
      {
        name: 'publish-replacement',
        type: FlowStepType.Capability,
        capability: 'example.publish-replacement',
      },
    ],
  });
}

function compileStable(flow: FlowDefinition) {
  const first = compileFlowDefinition(flow);
  const second = compileFlowDefinition(flow);
  expect(second.definitionDigest).toBe(first.definitionDigest);
  expect(JSON.stringify(first)).not.toMatch(/function |=>/);
  return first;
}

describe('E5 three-flow compiled harness', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('runs three compiled example flows on the two-DB harness; pin, approval-outcome, migrate refuse', async () => {
    harness = await createDurableTestHarness();
    expect(harness.spineName).toMatch(DURABLE_TEST_DB_PATTERN);
    expect(harness.tenantName).toMatch(DURABLE_TEST_DB_PATTERN);

    const a = flowA();
    const b = flowB();
    const c = flowCV1();
    const compiledA = compileStable(a);
    const compiledB = compileStable(b);
    const compiledC = compileStable(c);
    expect(compiledA.flowDefinitionId).toBe('example.flow-a');
    expect(compiledB.flowDefinitionId).toBe('example.flow-b');
    expect(compiledC.flowDefinitionId).toBe('example.flow-c');

    const registry = new FlowRegistry();
    registry.registerAll([a, b, c]);
    const compiledRegistry = new CompiledFlowRegistry();
    compiledRegistry.publish(compiledA);
    compiledRegistry.publish(compiledB);
    compiledRegistry.publish(compiledC);

    const ran: string[] = [];
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      compiledRegistry,
      approvals,
      stepDeps: {
        executeCapability: async (name: string) => {
          ran.push(name);
          return { success: true, data: {} };
        },
        evaluateCondition: () => true,
      },
      spineDispatch: {
        db: harness.spineDb,
        resolver: createSingleDataPlaneResolver(harness.tenantDb, {
          coreSchema: harness.coreSchema,
        }),
        coreSchema: harness.coreSchema,
      },
      flowLeaseDurationMs: 15_000,
    });

    const ctx = workerCtx();
    const startAuth = humanAuth();

    async function claimThis(executionId: string): Promise<void> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const rows = await engine.claimNext(5);
        if (rows.some((row) => row.id === executionId)) return;
      }
      throw new Error(`did not claim ${executionId}`);
    }

    const first = await engine.start('flow-a', { orderId: 'ord-1' }, startAuth);
    await claimThis(first.id);
    expect((await engine.runNext(first.id, ctx)).status).toBe(FlowStatus.Running);
    expect((await engine.runNext(first.id, ctx)).status).toBe(FlowStatus.Completed);

    const second = await engine.start('flow-b', { orderId: 'ord-1' }, startAuth);
    await approvals.requestApproval({
      capabilityId: 'example.review',
      definitionVersion: '1',
      input: { orderId: 'ord-1' },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 30_000),
      executionId: second.id,
    });
    const pending = await approvals.findByExecutionId(second.id);
    await approvals.decide({
      requestId: pending!.approvalRequestId,
      outcome: 'approved',
      auth: humanAuth(),
    });
    await claimThis(second.id);
    await engine.runNext(second.id, ctx);
    expect((await engine.runNext(second.id, ctx)).status).toBe(FlowStatus.Completed);

    const third = await engine.start('flow-c', { orderId: 'ord-1' }, startAuth);
    const [pin] = await harness.tenantDb
      .select({
        definitionVersion: flowExecutionsTable.definitionVersion,
        definitionDigest: flowExecutionsTable.definitionDigest,
      })
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, third.id))
      .limit(1);
    expect(pin.definitionVersion).toBe(compiledC.definitionVersion);
    expect(pin.definitionDigest).toBe(compiledC.definitionDigest);

    await claimThis(third.id);
    await engine.runNext(third.id, ctx);

    compiledRegistry.publish(compileFlowDefinition(flowCV2(), { definitionVersion: '2' }));
    expect(compiledRegistry.getLatest('example.flow-c')?.definitionVersion).toBe('2');

    await expect(engine.applyDefinitionStrategy(third.id, 'migrate')).rejects.toMatchObject({
      metadata: { reason: DEFINITION_STRATEGY_NOT_SUPPORTED, strategy: 'migrate' },
    });

    expect((await engine.runNext(third.id, ctx)).status).toBe(FlowStatus.Completed);
    expect(ran).toEqual([
      'example.accept',
      'example.queue',
      'example.record',
      'example.assemble',
      'example.publish-original',
    ]);
    expect(ran).not.toContain('example.publish-replacement');
  }, 15_000);
});
