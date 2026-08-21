// E6: cancel+compensate, dead-letter operator retry, budget exhaustion.
// Uses a plumbus_plan02_* harness DB and drops it on close.

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { flowExecutionsDdl, PLAN02_DB_NAME_PATTERN } from '../../durable/apply-ddl.js';
import { createPlan02Database } from '../../durable/harness.js';
import { FlowStepType } from '../../types/enums.js';
import { deadLetterFlow, retryDeadLetteredFlow } from '../dead-letter.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { flowDeadLetterTable, flowExecutionsTable } from '../schema.js';
import { FlowStatus } from '../state-machine.js';

function auth() {
  return { userId: 'u1', tenantId: 't-e6', roles: ['admin'], scopes: [], provider: 'test' };
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
    translations: { locale: 'en', t: (key: string) => key },
  } as never;
}

describe('E6 recovery harness', () => {
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const close of closers.reverse()) {
      await close();
    }
  });

  it(
    'cancels an in-flight flow after a compensable committed step; dead-letters then operator-retries; budget exhaustion fails closed',
    async () => {
      const tenant = await createPlan02Database({ kind: 'e6rec', ddl: flowExecutionsDdl() });
      closers.push(tenant.close);
      expect(tenant.name).toMatch(PLAN02_DB_NAME_PATTERN);
      expect(tenant.name).not.toMatch(/tenant_qv/);

      const registry = new FlowRegistry();
      registry.register(
        defineFlow({
          name: 'reserve-then-hold',
          domain: 'inventory',
          input: z.object({ sku: z.string() }),
          steps: [
            {
              name: 'reserve',
              type: FlowStepType.Capability,
              capability: 'inventory.reserve',
              compensate: 'inventory.release',
            },
            { name: 'hold', type: FlowStepType.Capability, capability: 'inventory.hold' },
          ],
        }),
      );
      registry.register(
        defineFlow({
          name: 'always-fail',
          domain: 'ops',
          input: z.object({ id: z.string() }),
          retry: { attempts: 0, backoff: 'fixed' },
          steps: [{ name: 'boom', type: FlowStepType.Capability, capability: 'ops.boom' }],
        }),
      );
      registry.register(
        defineFlow({
          name: 'budgeted',
          domain: 'ops',
          input: z.object({ id: z.string() }),
          budget: { profileId: 'plumbus.budget.default', allocated: 1 },
          steps: [
            { name: 'first', type: FlowStepType.Capability, capability: 'ops.first' },
            { name: 'second', type: FlowStepType.Capability, capability: 'ops.second' },
          ],
        }),
      );

      const ran: string[] = [];
      const engine = createFlowEngine({
        db: tenant.db,
        registry,
        workerId: 'e6-worker',
        stepDeps: {
          executeCapability: async (name: string) => {
            ran.push(name);
            if (name === 'ops.boom') return { success: false, error: 'exhausted' };
            return { success: true, data: {} };
          },
          evaluateCondition: () => true,
        },
        flowLeaseDurationMs: 15_000,
      });

      async function claim(executionId: string): Promise<void> {
        for (let attempt = 0; attempt < 8; attempt++) {
          const rows = await engine.claimNext(5);
          if (rows.some((row) => row.id === executionId)) return;
        }
        throw new Error(`did not claim ${executionId}`);
      }

      const reserved = await engine.start('reserve-then-hold', { sku: 'sku-1' }, auth());
      await claim(reserved.id);
      expect((await engine.runNext(reserved.id, ctx())).status).toBe(FlowStatus.Running);
      expect(ran).toContain('inventory.reserve');
      await engine.cancel(reserved.id, { actor: 'ops-ada' });
      expect(ran).toContain('inventory.release');
      expect((await engine.status(reserved.id)).status).toBe(FlowStatus.Cancelled);

      const failed = await engine.start('always-fail', { id: 'x' }, auth());
      await claim(failed.id);
      expect((await engine.runNext(failed.id, ctx())).status).toBe(FlowStatus.Failed);
      await deadLetterFlow(tenant.db, failed.id);
      const retry = await retryDeadLetteredFlow(tenant.db, failed.id, {
        actor: 'ops-ada',
        reason: 'operator-retry',
      });
      expect(retry.retriedBy).toBe('ops-ada');
      const [execution] = await tenant.db
        .select({
          status: flowExecutionsTable.status,
          retryCount: flowExecutionsTable.retryCount,
          state: flowExecutionsTable.state,
        })
        .from(flowExecutionsTable)
        .where(eq(flowExecutionsTable.id, failed.id))
        .limit(1);
      expect(execution.status).toBe(FlowStatus.Created);
      expect(execution.retryCount).toBe(0);
      expect(execution.state).toMatchObject({
        __operatorRetry: { retriedBy: 'ops-ada', reason: 'operator-retry' },
      });
      const [dlq] = await tenant.db
        .select({ metadata: flowDeadLetterTable.metadata })
        .from(flowDeadLetterTable)
        .where(eq(flowDeadLetterTable.executionId, failed.id))
        .limit(1);
      expect(dlq.metadata).toMatchObject({ retriedBy: 'ops-ada' });

      ran.length = 0;
      const budgeted = await engine.start('budgeted', { id: 'b1' }, auth());
      await claim(budgeted.id);
      expect((await engine.runNext(budgeted.id, ctx())).status).toBe(FlowStatus.Running);
      expect(ran).toEqual(['ops.first']);
      const exhausted = await engine.runNext(budgeted.id, ctx());
      expect(exhausted.status).toBe(FlowStatus.Failed);
      expect(ran).toEqual(['ops.first']);
      const [budgetRow] = await tenant.db
        .select({ lastError: flowExecutionsTable.lastError })
        .from(flowExecutionsTable)
        .where(eq(flowExecutionsTable.id, budgeted.id))
        .limit(1);
      expect(budgetRow.lastError).toBe('budget-exhausted');
    },
    20_000,
  );
});
