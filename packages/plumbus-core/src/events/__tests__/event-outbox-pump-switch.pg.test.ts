// The outbox dispatcher's `event_outbox` switch against real Postgres (core 0.9.0-beta.15,
// #200): a host that relays its own `event_outbox` keeps the framework from claiming its rows,
// per plane or everywhere, while flow dispatch hints (`dispatch_outbox`) are still published;
// and `WorkerPool.wakeOutbox` brings an idle-backed-off plane back on the next poll.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/index.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import type { PlumbusConfig } from '../../types/config.js';
import { createWorkerPool } from '../../worker/index.js';
import { FlowRegistry } from '../../flows/registry.js';
import { ConsumerRegistry } from '../consumer-registry.js';
import { createOutboxDispatcher } from '../dispatcher.js';
import { createInMemoryQueue } from '../queue.js';

async function withHarness(body: (harness: DurableTestHarness) => Promise<void>): Promise<void> {
  const harness = await createDurableTestHarness({ includeEventOutbox: true });
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

async function pendingEvent(db: PostgresJsDatabase): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO event_outbox (event_type, payload, actor, correlation_id)
    VALUES ('probe.happened', '{}'::jsonb, 'tester', 'corr') RETURNING id::text
  `);
  return String([...rows][0]?.id);
}

async function unpublishedHint(db: PostgresJsDatabase, executionId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO core_plumbus.dispatch_outbox (
      outbox_id, execution_id, state_ref_id, expected_revision, tenant_epoch, tenant_ref, step_id,
      definition_id, definition_version, correlation_id, work_class_id, priority_class_id,
      not_before, created_at, superseded
    ) VALUES (
      ${`outbox:${executionId}`}, ${executionId}, ${`state:${executionId}`}, 1, 1, 'tenant-a',
      'only', 'probe', '1', 'corr', 'default', 'default', now(), now(), false
    )
  `);
}

async function statusOf(db: PostgresJsDatabase, id: string): Promise<string | undefined> {
  const [row] = [
    ...(await db.execute<{ status: string }>(
      sql`SELECT status FROM event_outbox WHERE id = ${id}::uuid`,
    )),
  ];
  return row?.status;
}

async function hintCount(spine: PostgresJsDatabase): Promise<number> {
  const [row] = [
    ...(await spine.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM opaque_dispatch`)),
  ];
  return Number(row?.n ?? 0);
}

describe('event_outbox pump switch', () => {
  it('pumps both outboxes by default', async () => {
    await withHarness(async ({ tenantDb, spineDb, coreSchema }) => {
      const event = await pendingEvent(tenantDb);
      await unpublishedHint(tenantDb, 'exec-1');
      const queue = createInMemoryQueue();
      const dispatcher = createOutboxDispatcher({
        db: spineDb,
        queue,
        resolver: createSingleDataPlaneResolver(tenantDb, { coreSchema }),
        listTenantRefs: () => ['tenant-a'],
        spineDb,
        frameworkSchema: coreSchema,
      });
      await dispatcher.poll();
      expect(await statusOf(tenantDb, event)).toBe('dispatched');
      expect(await hintCount(spineDb)).toBe(1);
    });
  });

  it('leaves a host-relayed event_outbox alone and still publishes flow dispatch hints', async () => {
    await withHarness(async ({ tenantDb, spineDb, coreSchema }) => {
      const event = await pendingEvent(tenantDb);
      await unpublishedHint(tenantDb, 'exec-1');
      const published: string[] = [];
      const queue = createInMemoryQueue();
      queue.subscribe(async (envelope) => {
        published.push(envelope.id);
      });
      const asked: Array<string | undefined> = [];
      const dispatcher = createOutboxDispatcher({
        db: spineDb,
        queue,
        resolver: createSingleDataPlaneResolver(tenantDb, { coreSchema }),
        listTenantRefs: () => ['tenant-a'],
        spineDb,
        frameworkSchema: coreSchema,
        pumpEventOutbox: (tenantRef) => {
          asked.push(tenantRef);
          return tenantRef !== 'tenant-a';
        },
      });
      await dispatcher.poll();
      expect(asked).toEqual(['tenant-a']);
      expect(await statusOf(tenantDb, event)).toBe('pending');
      expect(published).toEqual([]);
      expect(await hintCount(spineDb)).toBe(1);
    });
  });

  it('does not touch the pool database at all when it has nothing of its own to pump', async () => {
    await withHarness(async ({ tenantDb }) => {
      const event = await pendingEvent(tenantDb);
      const dispatcher = createOutboxDispatcher({
        db: tenantDb,
        queue: createInMemoryQueue(),
        pumpEventOutbox: false,
      });
      expect(await dispatcher.poll()).toBe(0);
      expect(await statusOf(tenantDb, event)).toBe('pending');
    });
  });

  it('reads workers.eventOutboxPump in the worker pool, and wakeOutbox ends an idle back-off', async () => {
    await withHarness(async ({ tenantDb, spineDb, coreSchema, admin }) => {
      const config = (workers: PlumbusConfig['workers']) =>
        ({ environment: 'test', database: admin, workers }) as PlumbusConfig;
      const pool = (workers: PlumbusConfig['workers']) =>
        createWorkerPool({
          config: config(workers),
          db: spineDb,
          flows: new FlowRegistry(),
          consumers: new ConsumerRegistry(),
          queue: createInMemoryQueue(),
          audit: { record: async () => {} },
          dataPlaneResolver: createSingleDataPlaneResolver(tenantDb, { coreSchema }),
          listTenantRefs: () => ['tenant-a'],
          frameworkSchema: coreSchema,
          enableScheduler: false,
          enableEventWorker: false,
          enableFlowRunner: false,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          stepDeps: {
            async executeCapability() {
              return { success: true, data: {} };
            },
            evaluateCondition: () => true,
          },
        });

      const relayed = await pendingEvent(tenantDb);
      const off = pool({ eventOutboxPump: 'none', outboxPollIntervalMs: 20 });
      await off.start();
      await unpublishedHint(tenantDb, 'exec-2');
      await expect.poll(() => hintCount(spineDb), { timeout: 5_000 }).toBe(1);
      await off.stop();
      expect(await statusOf(tenantDb, relayed)).toBe('pending');

      // Pump on, with a long idle back-off: an idle visit backs the plane off; a new event waits
      // out the back-off unless the host wakes the outbox.
      await tenantDb.execute(sql`UPDATE event_outbox SET status = 'dispatched'`);
      const on = pool({ outboxPollIntervalMs: 20, outboxIdleBackoffMaxMs: 60_000 });
      await on.start();
      try {
        // Idle visits at about 0, 20, 60, 140, 300, 620 and 1260 ms; the next one about 2.5 s.
        await new Promise((resolve) => setTimeout(resolve, 1_350));
        const late = await pendingEvent(tenantDb);
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(await statusOf(tenantDb, late)).toBe('pending');
        on.wakeOutbox?.('tenant-a');
        await expect.poll(() => statusOf(tenantDb, late), { timeout: 2_000 }).toBe('dispatched');
      } finally {
        await on.stop();
      }
    });
  }, 30_000);
});
