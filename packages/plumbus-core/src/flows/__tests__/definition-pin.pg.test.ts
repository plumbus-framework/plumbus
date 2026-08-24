import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { flowExecutionsDdl, DURABLE_TEST_DB_PATTERN } from '../../durable/apply-ddl.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { FlowStepType } from '../../types/enums.js';
import { compileFlowDefinition } from '../compile-flow.js';
import { CompiledFlowRegistry } from '../compiled-registry.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { flowExecutionsTable } from '../schema.js';
import { FlowStatus } from '../state-machine.js';

function auth() {
  return { userId: 'u1', tenantId: 't1', roles: ['admin'], scopes: [], provider: 'test' };
}

function ctx(): never {
  return {
    auth: auth(),
    data: {},
    events: { emit: async () => undefined, emitMany: async () => undefined },
    flows: { start: async () => ({ id: '', flowName: '', status: FlowStatus.Created }) },
    ai: {},
    audit: { record: async () => undefined },
    errors: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    time: { now: () => new Date() },
    config: {},
    security: {},
    translations: { locale: 'en', t: (k: string) => k },
  } as never;
}

describe('durable compiled definition pin on flow_executions', () => {
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const close of closers.reverse()) {
      await close();
    }
  });

  it('stores version+digest on the row and a new engine instance completes on the original', async () => {
    const tenant = await createDurableTestDatabase({ kind: 'flowpin', ddl: flowExecutionsDdl() });
    closers.push(tenant.close);
    expect(tenant.name).toMatch(DURABLE_TEST_DB_PATTERN);

    const v1 = defineFlow({
      name: 'pin-me',
      domain: 'ops',
      input: z.object({ id: z.string() }),
      steps: [
        { name: 'first', type: FlowStepType.Capability, capability: 'ops.first' },
        { name: 'original-step', type: FlowStepType.Capability, capability: 'ops.original' },
      ],
    });
    const v2 = defineFlow({
      name: 'pin-me',
      domain: 'ops',
      input: z.object({ id: z.string() }),
      steps: [
        { name: 'first', type: FlowStepType.Capability, capability: 'ops.first' },
        { name: 'replacement-step', type: FlowStepType.Capability, capability: 'ops.replacement' },
      ],
    });

    const registry = new FlowRegistry();
    registry.register(v1);
    const compiledRegistry = new CompiledFlowRegistry();
    const compiledV1 = compileFlowDefinition(v1, { definitionVersion: '1' });
    compiledRegistry.publish(compiledV1);

    const starter = createFlowEngine({
      db: tenant.db,
      registry,
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
      compiledRegistry,
    });
    const exec = await starter.start('pin-me', { id: '1' }, auth());

    const [pinRow] = await tenant.db
      .select({
        definitionVersion: flowExecutionsTable.definitionVersion,
        definitionDigest: flowExecutionsTable.definitionDigest,
      })
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, exec.id))
      .limit(1);
    expect(pinRow.definitionVersion).toBe('1');
    expect(pinRow.definitionDigest).toBe(compiledV1.definitionDigest);

    const ran: string[] = [];
    const otherProcess = createFlowEngine({
      db: tenant.db,
      registry,
      stepDeps: {
        executeCapability: async (name: string) => {
          ran.push(name);
          return { success: true, data: {} };
        },
        evaluateCondition: () => true,
      },
      compiledRegistry,
    });
    const claimed = await otherProcess.claimNext(1);
    expect(claimed.map((row) => row.id)).toEqual([exec.id]);
    await otherProcess.runNext(exec.id, ctx());

    compiledRegistry.publish(compileFlowDefinition(v2, { definitionVersion: '2' }));
    await otherProcess.runNext(exec.id, ctx());
    expect(ran).toEqual(['ops.first', 'ops.original']);
    expect(ran).not.toContain('ops.replacement');
  });
});
