import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/index.js';
import { createDurableTestHarness, flowExecutionsDdl } from '../../durable/index.js';
import { ConsumerRegistry, createInMemoryQueue } from '../../events/index.js';
import { FlowRegistry } from '../../flows/index.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import type { PlumbusConfig } from '../../types/config.js';
import { FlowStepType } from '../../types/enums.js';
import { createWorkerPool } from '../index.js';

// Exercises the actual polling worker, engine, tenant database and spine hints together.
describe('polling flow leases', () => {
  it('leaves queued work unclaimed while a slow flow runs and lets a peer execute it once', async () => {
    const harness = await createDurableTestHarness();
    for (const ddl of flowExecutionsDdl()
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean))
      await harness.spineDb.execute(sql.raw(ddl));
    const flows = new FlowRegistry();
    flows.register(
      defineFlow({
        name: 'lease-probe',
        domain: 'testing',
        input: z.object({ work: z.string() }),
        steps: [{ name: 'only', type: FlowStepType.Capability, capability: 'testing.probe' }],
      }),
    );
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const makePool = () =>
      createWorkerPool({
        // The in-memory queue is supplied directly; no queue server is configured or contacted.
        config: { environment: 'test', database: harness.admin } as PlumbusConfig,
        db: harness.spineDb,
        flows,
        consumers: new ConsumerRegistry(),
        queue: createInMemoryQueue(),
        audit: { record: async () => {} },
        dataPlaneResolver: createSingleDataPlaneResolver(harness.tenantDb, {
          coreSchema: harness.coreSchema,
        }),
        frameworkSchema: harness.coreSchema,
        enableScheduler: false,
        enableDispatcher: false,
        enableEventWorker: false,
        flowPollIntervalMs: 20,
        flowLeaseDurationMs: 250,
        flowHeartbeatIntervalMs: 30,
        flowClaimBatchSize: 2,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        stepDeps: {
          async executeCapability(_name, _ctx, input) {
            const { work } = z.object({ work: z.string() }).parse(input);
            calls.push(work);
            if (work === 'slow') await blocked;
            return { success: true, data: {} };
          },
          evaluateCondition: () => true,
        },
      });
    const a = makePool();
    const b = makePool();
    try {
      const auth = {
        userId: 'tester',
        roles: ['system'],
        scopes: [],
        provider: 'test',
        tenantId: 'tenant-a',
      };
      const slow = await a.flowEngine.start('lease-probe', { work: 'slow' }, auth);
      const next = await a.flowEngine.start('lease-probe', { work: 'next' }, auth);
      await a.start();
      await vi.waitFor(() => expect(calls).toEqual(['slow']));
      await new Promise((resolve) => setTimeout(resolve, 800));
      const waiting = await harness.spineDb.execute(
        sql`SELECT delivery_state, attempt FROM opaque_dispatch WHERE execution_id = ${next.id}`,
      );
      expect([...waiting]).toEqual([{ delivery_state: 'ready', attempt: 0 }]);
      await b.start();
      await vi.waitFor(() => expect(calls).toEqual(['slow', 'next']));
      release();
      await vi.waitFor(async () => {
        expect((await a.flowEngine.status(slow.id)).status).toBe('completed');
        expect((await b.flowEngine.status(next.id)).status).toBe('completed');
      });
      const attempts = await harness.spineDb.execute(
        sql`SELECT attempt FROM opaque_dispatch ORDER BY execution_id`,
      );
      expect([...attempts]).toEqual([{ attempt: 1 }, { attempt: 1 }]);
      expect(calls).toEqual(['slow', 'next']);
    } finally {
      release();
      await a.stop();
      await b.stop();
      await harness.close();
    }
  }, 20_000);
});
