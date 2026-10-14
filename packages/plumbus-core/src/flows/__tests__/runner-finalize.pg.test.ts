import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';
import { loadExecutionState } from '../../durable/postgres-persist.js';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { FlowStepType } from '../../types/enums.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { flowDeadLetterTable, flowExecutionsTable } from '../schema.js';

describe('fenced runner finalization on the spine path', () => {
  let harness: DurableTestHarness;
  afterAll(async () => {
    await harness?.close();
  });
  it('finalizes a tenant run that threw, closes durable state, acks the hint, dead-letters on the plane', async () => {
    harness = await createDurableTestHarness();
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'boom',
        domain: 'durable',
        input: z.object({}),
        steps: [{ name: 'a', type: FlowStepType.Capability, capability: 'x.a' }],
      }),
    );
    const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
      coreSchema: harness.coreSchema,
    });
    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      createContext: () => {
        throw new Error('context exploded');
      },
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
      spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
      flowLeaseDurationMs: 30_000,
    });
    const started = await engine.start(
      'boom',
      {},
      { userId: 'u', roles: [], scopes: [], provider: 't', tenantId: 'tenant-a' },
    );
    const [claimed] = await engine.claimNext(5);
    const err = await engine
      .runNext(started.id, {} as never, claimed?.leaseToken ?? undefined)
      .catch((e) => e);
    expect(err.message).toBe('context exploded');
    expect(await engine.markFailedFromRunner(started.id, err, crypto.randomUUID())).toBe(false);
    expect(
      await engine.markFailedFromRunner(started.id, err, claimed?.leaseToken ?? undefined),
    ).toBe(true);
    const [row] = await harness.tenantDb
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, started.id));
    expect(row).toMatchObject({
      status: 'failed',
      lastError: 'context exploded',
      leaseToken: null,
    });
    expect(await harness.tenantDb.select().from(flowDeadLetterTable)).toHaveLength(1);
    expect(
      (await loadExecutionState(harness.tenantDb, started.id, harness.coreSchema))?.terminal,
    ).toBe(true);
    const hints = (await harness.spineDb.execute(
      sql`SELECT delivery_state FROM opaque_dispatch WHERE execution_id = ${started.id}`,
    )) as unknown as Array<{ delivery_state: string }>;
    expect(hints.map((h) => h.delivery_state)).toEqual(['acknowledged']);
    expect(await engine.claimNext(5)).toEqual([]);
  });
});
