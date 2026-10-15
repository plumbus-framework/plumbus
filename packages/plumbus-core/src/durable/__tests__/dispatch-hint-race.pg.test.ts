// P6 reproduction: a dispatch_outbox pump that read an outbox row before its owner published
// it must not reset the spine hint a worker has since leased, and a tenant row whose lease is
// live must not be claimed a second time.
//
// Deterministic interleaving with the real dispatcher and engines: the pump's spine
// connection is gated so its upsert runs exactly after worker A has claimed the hint.

import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/index.js';
import { createOutboxDispatcher } from '../../events/dispatcher.js';
import { createInMemoryQueue } from '../../events/index.js';
import { createFlowEngine } from '../../flows/engine.js';
import { FlowRegistry } from '../../flows/registry.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import { FlowStepType } from '../../types/enums.js';
import { createDurableTestHarness, extraHarnessConnection } from '../harness.js';

const tenantAuth = {
  userId: 'u1',
  roles: ['admin'],
  scopes: [],
  provider: 'test',
  tenantId: 'tenant-a',
};

/** A spine handle whose `opaque_dispatch` upserts wait until the gate opens. */
function gatedSpine(db: PostgresJsDatabase) {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'execute') {
        return async (query: SQL) => {
          const text = new (await import('drizzle-orm/pg-core')).PgDialect().sqlToQuery(query).sql;
          if (text.includes('INSERT INTO opaque_dispatch')) {
            reached();
            await opened;
          }
          return target.execute(query);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { db: proxy, open, arrived };
}

describe('dispatch hint race (P6)', () => {
  it('a pump that read the outbox row before publication does not hand a leased step to a second worker', async () => {
    const harness = await createDurableTestHarness({ includeEventOutbox: true });
    const closers: Array<() => Promise<void>> = [];
    try {
      const flows = new FlowRegistry();
      flows.register(
        defineFlow({
          name: 'race-probe',
          domain: 'testing',
          input: z.object({}),
          steps: [{ name: 'only', type: FlowStepType.Capability, capability: 'testing.only' }],
        }),
      );
      // Each process has its own tenant connection (the harness pools hold one each).
      const engineFor = async (workerId: string) => {
        const tenant = await extraHarnessConnection(harness.admin, harness.tenantName);
        closers.push(tenant.close);
        const resolver = createSingleDataPlaneResolver(tenant.db, {
          coreSchema: harness.coreSchema,
        });
        return createFlowEngine({
          db: harness.spineDb,
          registry: flows,
          stepDeps: {
            executeCapability: async () => ({ success: true, data: {} }),
            evaluateCondition: () => true,
          },
          workerId,
          spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
        });
      };
      const api = await engineFor('api');
      const workerA = await engineFor('worker-a');
      const workerB = await engineFor('worker-b');

      // The execution and its acceptance outbox row commit; the hint is not published yet
      // (the window between a start's commit and its announcement).
      const pending = await harness.tenantDb.transaction((tx) =>
        api.createExecution(tx as unknown as PostgresJsDatabase, 'race-probe', {}, tenantAuth),
      );

      // Another process's dispatcher pump (its own connections) reads the unpublished row
      // and is about to upsert.
      const pumpTenant = await extraHarnessConnection(harness.admin, harness.tenantName);
      closers.push(pumpTenant.close);
      const gate = gatedSpine(harness.spineDb);
      const pump = createOutboxDispatcher({
        db: harness.spineDb,
        queue: createInMemoryQueue(),
        resolver: createSingleDataPlaneResolver(pumpTenant.db, {
          coreSchema: harness.coreSchema,
        }),
        listTenantRefs: () => ['tenant-a'],
        spineDb: gate.db,
        frameworkSchema: harness.coreSchema,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      const pumping = pump.poll();
      await gate.arrived;

      // The owner publishes the hint (marking its outbox row published waits for the pump's
      // row lock); worker A claims the hint and holds a live lease.
      const announcing = api.announceExecution(pending, {
        store: harness.tenantDb,
        auth: tenantAuth,
      });
      await vi.waitFor(async () => {
        const hints = await harness.spineDb.execute(
          sql`SELECT 1 FROM opaque_dispatch WHERE execution_id = ${pending.id}`,
        );
        expect([...hints]).toHaveLength(1);
      });
      const claimedByA = await workerA.claimNext(1);
      expect(claimedByA.map((row) => row.id)).toEqual([pending.id]);

      // The pump's stale upsert lands now.
      gate.open();
      await pumping;
      await announcing;

      const [hint] = [
        ...(await harness.spineDb.execute<{ delivery_state: string; lease_ref_id: string }>(
          sql`SELECT delivery_state, lease_ref_id FROM opaque_dispatch WHERE execution_id = ${pending.id}`,
        )),
      ];
      expect(hint, 'the leased hint was reset by the stale pump upsert').toEqual({
        delivery_state: 'leased',
        lease_ref_id: 'worker-a',
      });

      // Worker B must not get the step A is running.
      const claimedByB = await workerB.claimNext(1);
      expect(
        claimedByB.map((row) => row.id),
        'worker B claimed the execution worker A holds a live lease on',
      ).toEqual([]);
      const [tenantRow] = [
        ...(await harness.tenantDb.execute<{ lease_owner: string }>(
          sql`SELECT lease_owner FROM flow_executions WHERE id = ${pending.id}`,
        )),
      ];
      expect(tenantRow?.lease_owner).toBe('worker-a');
    } finally {
      for (const close of closers) await close();
      await harness.close();
    }
  }, 30_000);

  it('the tenant-row claim does not take a row whose lease is live, and hands the hint back', async () => {
    const harness = await createDurableTestHarness();
    try {
      const flows = new FlowRegistry();
      flows.register(
        defineFlow({
          name: 'race-probe',
          domain: 'testing',
          input: z.object({}),
          steps: [{ name: 'only', type: FlowStepType.Capability, capability: 'testing.only' }],
        }),
      );
      const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
        coreSchema: harness.coreSchema,
      });
      const engineFor = (workerId: string) =>
        createFlowEngine({
          db: harness.spineDb,
          registry: flows,
          stepDeps: {
            executeCapability: async () => ({ success: true, data: {} }),
            evaluateCondition: () => true,
          },
          workerId,
          spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
        });
      const workerA = engineFor('worker-a');
      const workerB = engineFor('worker-b');
      const started = await workerA.start('race-probe', {}, tenantAuth);
      expect((await workerA.claimNext(1)).map((row) => row.id)).toEqual([started.id]);

      // However the hint became claimable again (here: its lease lapsed early), the tenant row
      // is still worker A's.
      await harness.spineDb.execute(
        sql`UPDATE opaque_dispatch SET lease_expires_at = now() - interval '1 second'
            WHERE execution_id = ${started.id}`,
      );
      expect(await workerB.claimNext(1)).toEqual([]);

      const [tenantRow] = [
        ...(await harness.tenantDb.execute<{ lease_owner: string; lease_expires_at: Date }>(
          sql`SELECT lease_owner, lease_expires_at FROM flow_executions WHERE id = ${started.id}`,
        )),
      ];
      expect(tenantRow?.lease_owner).toBe('worker-a');
      const [hint] = [
        ...(await harness.spineDb.execute<{
          delivery_state: string;
          lease_ref_id: string | null;
          waits_for_row_lease: boolean;
        }>(sql`
          SELECT delivery_state, lease_ref_id,
                 not_before >= ${tenantRow?.lease_expires_at}::timestamptz - interval '1 millisecond'
                   AS waits_for_row_lease
          FROM opaque_dispatch WHERE execution_id = ${started.id}
        `)),
      ];
      expect(hint).toEqual({
        delivery_state: 'ready',
        lease_ref_id: null,
        waits_for_row_lease: true,
      });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('two pumps publish each outbox row once', async () => {
    const harness = await createDurableTestHarness({ includeEventOutbox: true });
    try {
      const flows = new FlowRegistry();
      flows.register(
        defineFlow({
          name: 'race-probe',
          domain: 'testing',
          input: z.object({}),
          steps: [{ name: 'only', type: FlowStepType.Capability, capability: 'testing.only' }],
        }),
      );
      const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
        coreSchema: harness.coreSchema,
      });
      const engine = createFlowEngine({
        db: harness.spineDb,
        registry: flows,
        stepDeps: {
          executeCapability: async () => ({ success: true, data: {} }),
          evaluateCondition: () => true,
        },
        spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
      });
      for (let i = 0; i < 20; i += 1) {
        await harness.tenantDb.transaction((tx) =>
          engine.createExecution(tx as unknown as PostgresJsDatabase, 'race-probe', {}, tenantAuth),
        );
      }
      const upserts: string[] = [];
      const counting = new Proxy(harness.spineDb, {
        get(target, property, receiver) {
          if (property === 'execute') {
            return async (query: SQL) => {
              const built = new (await import('drizzle-orm/pg-core')).PgDialect().sqlToQuery(query);
              if (built.sql.includes('INSERT INTO opaque_dispatch')) {
                upserts.push(String(built.params[0]));
              }
              return target.execute(query);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const pumpFor = () =>
        createOutboxDispatcher({
          db: harness.spineDb,
          queue: createInMemoryQueue(),
          resolver,
          listTenantRefs: () => ['tenant-a'],
          spineDb: counting,
          frameworkSchema: harness.coreSchema,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        });
      await Promise.all([pumpFor().poll(), pumpFor().poll()]);
      expect(upserts).toHaveLength(20);
      expect(new Set(upserts).size).toBe(20);
      const [published] = [
        ...(await harness.spineDb.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM opaque_dispatch WHERE delivery_state = 'ready'`,
        )),
      ];
      expect(published?.n).toBe(20);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
