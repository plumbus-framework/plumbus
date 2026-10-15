// WorkerPool.stop({ deadlineAt }) against real Postgres: the running step finishes, the
// execution is released (not drained, not failed) and another worker continues it at once.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/index.js';
import {
  createDurableTestHarness,
  type DurableTestHarness,
  flowExecutionsDdl,
} from '../../durable/index.js';
import { ConsumerRegistry, createInMemoryQueue } from '../../events/index.js';
import { FlowRegistry } from '../../flows/index.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import type { PlumbusConfig } from '../../types/config.js';
import { FlowStepType } from '../../types/enums.js';
import { createWorkerPool, type WorkerPool } from '../index.js';

const auth = {
  userId: 'tester',
  roles: ['system'],
  scopes: [],
  provider: 'test',
  tenantId: 'tenant-a',
};

function twoStepFlows(): FlowRegistry {
  const flows = new FlowRegistry();
  flows.register(
    defineFlow({
      name: 'drain-probe',
      domain: 'testing',
      input: z.object({}),
      steps: [
        { name: 'first', type: FlowStepType.Capability, capability: 'testing.first' },
        { name: 'second', type: FlowStepType.Capability, capability: 'testing.second' },
      ],
    }),
  );
  return flows;
}

interface Probe {
  calls: Array<{ capability: string; workerId: string | undefined }>;
  release(): void;
  blocked: Promise<void>;
}

function probe(): Probe {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { calls: [], release, blocked };
}

function makePool(
  harness: DurableTestHarness,
  flows: FlowRegistry,
  state: Probe,
  placement: 'tenant-plane' | 'own-table',
): WorkerPool {
  return createWorkerPool({
    config: { environment: 'test', database: harness.admin } as PlumbusConfig,
    db: harness.spineDb,
    flows,
    consumers: new ConsumerRegistry(),
    queue: createInMemoryQueue(),
    audit: { record: async () => {} },
    ...(placement === 'tenant-plane'
      ? {
          dataPlaneResolver: createSingleDataPlaneResolver(harness.tenantDb, {
            coreSchema: harness.coreSchema,
          }),
          frameworkSchema: harness.coreSchema,
        }
      : {}),
    enableScheduler: false,
    enableDispatcher: false,
    enableEventWorker: false,
    flowPollIntervalMs: 20,
    // Far longer than the test: a peer can only run the execution because it was released.
    flowLeaseDurationMs: 60_000,
    flowHeartbeatIntervalMs: 10_000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    stepDeps: {
      async executeCapability(name, ctx) {
        state.calls.push({ capability: name, workerId: ctx.workerId });
        if (name === 'testing.first') await state.blocked;
        return { success: true, data: {} };
      },
      evaluateCondition: () => true,
    },
  });
}

async function flowRow(db: PostgresJsDatabase, id: string) {
  const rows = await db.execute<{
    status: string;
    current_step: string | null;
    lease_owner: string | null;
    lease_released: boolean;
  }>(sql`
    SELECT status, current_step, lease_owner, lease_expires_at <= now() AS lease_released
    FROM flow_executions WHERE id = ${id}
  `);
  return [...rows][0];
}

async function withHarness(
  body: (harness: DurableTestHarness, pools: WorkerPool[]) => Promise<void>,
): Promise<void> {
  const harness = await createDurableTestHarness();
  for (const ddl of flowExecutionsDdl()
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean))
    await harness.spineDb.execute(sql.raw(ddl));
  const pools: WorkerPool[] = [];
  try {
    await body(harness, pools);
  } finally {
    for (const pool of pools) await pool.stop().catch(() => undefined);
    await harness.close();
  }
}

describe('worker pool shutdown drain', () => {
  it.each([
    'tenant-plane',
    'own-table',
  ] as const)('finishes the running step, releases the execution, and a peer continues it (%s)', async (placement) => {
    await withHarness(async (harness, pools) => {
      const flows = twoStepFlows();
      const state = probe();
      const a = makePool(harness, flows, state, placement);
      const b = makePool(harness, flows, state, placement);
      pools.push(a, b);
      const planeDb = placement === 'tenant-plane' ? harness.tenantDb : harness.spineDb;

      const started = await a.flowEngine.start(
        'drain-probe',
        {},
        placement === 'tenant-plane' ? auth : { ...auth, tenantId: undefined },
      );
      await a.start();
      await vi.waitFor(() =>
        expect(state.calls.map((call) => call.capability)).toEqual(['testing.first']),
      );

      const stopping = a.stop({ deadlineAt: Date.now() + 10_000 });
      // The step is still running: stop waits for it rather than abandoning it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(a.flowCycleInFlight).toBe(true);
      state.release();
      await stopping;
      expect(a.flowCycleInFlight).toBe(false);

      // The first step committed; the second was not drained, and nothing failed.
      const released = await flowRow(planeDb, started.id);
      expect(released).toMatchObject({
        status: 'running',
        current_step: 'second',
        lease_owner: null,
        lease_released: true,
      });
      if (placement === 'tenant-plane') {
        const hints = await harness.spineDb.execute<{ step_id: string; delivery_state: string }>(
          sql`SELECT step_id, delivery_state FROM opaque_dispatch
              WHERE execution_id = ${started.id} AND delivery_state <> 'acknowledged'`,
        );
        expect([...hints]).toEqual([{ step_id: 'second', delivery_state: 'ready' }]);
      }

      await b.start();
      await vi.waitFor(async () => {
        expect((await b.flowEngine.status(started.id)).status).toBe('completed');
      });
      expect(state.calls).toEqual([
        { capability: 'testing.first', workerId: a.flowEngine.workerId },
        { capability: 'testing.second', workerId: b.flowEngine.workerId },
      ]);
    });
  }, 30_000);

  it('abandons a step still running at the deadline and leaves the execution leased, not failed', async () => {
    await withHarness(async (harness, pools) => {
      const flows = twoStepFlows();
      const state = probe();
      const a = makePool(harness, flows, state, 'tenant-plane');
      pools.push(a);

      const started = await a.flowEngine.start('drain-probe', {}, auth);
      await a.start();
      await vi.waitFor(() => expect(state.calls).toHaveLength(1));

      const before = Date.now();
      await a.stop({ deadlineAt: before + 300 });
      expect(Date.now() - before).toBeLessThan(5_000);
      expect(a.flowCycleInFlight).toBe(true);

      const row = await flowRow(harness.tenantDb, started.id);
      expect(row).toMatchObject({
        status: 'running',
        current_step: 'first',
        lease_owner: a.flowEngine.workerId,
        lease_released: false,
      });
      state.release();
      await vi.waitFor(() => expect(a.flowCycleInFlight).toBe(false));
    });
  }, 30_000);
});
