// More tenants than cache slots, used concurrently, on real PostgreSQL databases: the
// outbox dispatcher and the scheduler walk every tenant while requests hold planes, and no
// plane is closed under its user, no tenant is skipped, and the connections to the tenant
// databases never pass cacheSize × pool size.
//
// Every database here is a plumbus_durable_test_* database this file creates and drops.

import { sql } from 'drizzle-orm';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { eventOutboxDdl } from '../../durable/apply-ddl.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { resolveTestPostgresAdmin } from '../../durable/pg-env.js';
import { createOutboxDispatcher } from '../../events/dispatcher.js';
import { createInMemoryQueue } from '../../events/queue.js';
import { createFlowEngine } from '../../flows/engine.js';
import { FlowRegistry } from '../../flows/registry.js';
import * as flowTables from '../../flows/schema.js';
import { createFlowScheduler } from '../../flows/scheduler.js';
import type { EventEnvelope } from '../../types/event.js';
import { openDataPlaneConnection } from '../data-plane-connection.js';
import { createPooledDataPlaneResolver } from '../data-plane-resolver.js';
import type { DataPlaneHandle, DataPlaneResolver } from '../types.js';

const admin = resolveTestPostgresAdmin();
const TENANTS = 6;
const CACHE_SIZE = 2;
const POOL_SIZE = 2;
const APPLICATION = `plumbus_lease_${process.pid}`;

const databases: Array<{ name: string; close(): Promise<void> }> = [];
const refs: string[] = [];
let probe: postgres.Sql;

beforeAll(async () => {
  const flowDdl = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(flowTables));
  for (let i = 0; i < TENANTS; i += 1) {
    const database = await createDurableTestDatabase({
      admin,
      kind: 'lease',
      ddl: eventOutboxDdl(),
    });
    databases.push(database);
    refs.push(database.name);
    const client = postgres({
      host: admin.host,
      port: admin.port,
      database: database.name,
      username: admin.user,
      password: admin.password,
      max: 1,
      onnotice: () => {},
    });
    for (const statement of flowDdl) await client.unsafe(statement);
    await client.end({ timeout: 5 });
  }
  probe = postgres({
    host: admin.host,
    port: admin.port,
    database: admin.database,
    username: admin.user,
    password: admin.password,
    max: 1,
    onnotice: () => {},
  });
}, 120_000);

afterAll(async () => {
  await probe?.end({ timeout: 5 });
  for (const database of databases) await database.close();
}, 120_000);

function resolverFor() {
  return createPooledDataPlaneResolver({
    cacheSize: CACHE_SIZE,
    describe: async (tenantRef: string) =>
      refs.includes(tenantRef) ? { connectionInfo: tenantRef } : undefined,
    connect: ({ descriptor }) =>
      openDataPlaneConnection({
        target: {
          host: admin.host,
          port: admin.port,
          database: descriptor.connectionInfo as string,
          user: admin.user,
          password: admin.password,
        },
        maxConnections: POOL_SIZE,
        applicationName: APPLICATION,
      }),
  });
}

/**
 * Hold a tenant's plane the way a request does: under a lease where the resolver offers
 * one. (Written against `resolve` too so this file shows what happened before leases.)
 */
async function hold(
  resolver: DataPlaneResolver,
  tenantRef: string,
): Promise<{ handle: DataPlaneHandle; release(): void }> {
  if (resolver.acquire) return resolver.acquire(tenantRef);
  return { handle: await resolver.resolve(tenantRef), release() {} };
}

/** Sample the backends this file opened to tenant databases until `stop()`. */
function sampleBackends() {
  let max = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const rows = await probe<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${APPLICATION}
      `;
      max = Math.max(max, rows[0]?.n ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return max;
    },
  };
}

async function seedOneEventPerTenant(): Promise<void> {
  for (const tenantRef of refs) {
    const client = postgres({
      host: admin.host,
      port: admin.port,
      database: tenantRef,
      username: admin.user,
      password: admin.password,
      max: 1,
      onnotice: () => {},
    });
    await client`
      INSERT INTO event_outbox (event_type, payload, actor, tenant_id, correlation_id)
      VALUES ('lease.test', ${client.json({ tenantRef })}, 'tester', ${tenantRef}, ${`c-${tenantRef}`})
    `;
    await client.end({ timeout: 5 });
  }
}

describe(`${TENANTS} tenants through a cache of ${CACHE_SIZE}, used concurrently`, () => {
  it('the outbox dispatcher pumps every tenant while requests hold planes, and nothing is closed under its user', async () => {
    await seedOneEventPerTenant();
    const resolver = resolverFor();
    const queue = createInMemoryQueue();
    const published: EventEnvelope[] = [];
    queue.subscribe(async (envelope) => {
      published.push(envelope);
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const dispatcher = createOutboxDispatcher({
      db: undefined as never,
      queue,
      logger,
      resolver,
      listTenantRefs: () => refs,
    });

    const sampler = sampleBackends();
    const requestFailures: unknown[] = [];
    const requests = Array.from({ length: 12 }, async (_, i) => {
      const tenantRef = refs[i % refs.length] ?? '';
      try {
        const plane = await hold(resolver, tenantRef);
        try {
          await plane.handle.db.execute(sql`SELECT pg_sleep(0.15)`);
          await plane.handle.db.execute(sql`SELECT count(*) FROM event_outbox`);
        } finally {
          plane.release();
        }
      } catch (error) {
        requestFailures.push(error);
      }
    });
    const polls = (async () => {
      for (let cycle = 0; cycle < 3; cycle += 1) await dispatcher.poll();
    })();
    await Promise.all([...requests, polls]);
    const maxBackends = await sampler.stop();

    expect(requestFailures).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(published.map((envelope) => envelope.tenantId).sort()).toEqual([...refs].sort());
    expect(maxBackends).toBeLessThanOrEqual(CACHE_SIZE * POOL_SIZE);
    await resolver.close();
  }, 60_000);

  it('schedule reconciliation covers every tenant plane (the deploy-time schedule sync)', async () => {
    const resolver = resolverFor();
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'nightly',
        domain: 'test',
        input: z.object({}),
        schedule: { cron: 'every:1h' },
        steps: [{ name: 'one', type: 'capability' }],
      }),
    );
    const engine = createFlowEngine({
      db: undefined as never,
      registry,
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
    });
    const scheduler = createFlowScheduler({
      db: undefined as never,
      registry,
      engine,
      resolver,
      listTenantRefs: () => refs,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    const sampler = sampleBackends();
    const preview = await scheduler.reconcileSchedules();
    const applied = await scheduler.reconcileSchedules({
      apply: true,
      expectedRevision: preview.revision,
    });
    const maxBackends = await sampler.stop();

    expect(preview.changes.map((change) => change.tenantRef).sort()).toEqual([...refs].sort());
    expect(applied.changes).toHaveLength(TENANTS);
    expect(maxBackends).toBeLessThanOrEqual(CACHE_SIZE * POOL_SIZE);
    const again = await scheduler.reconcileSchedules();
    expect(again.changes).toEqual([]);
    await resolver.close();
  }, 60_000);

  it('a full cache of leased planes refuses a further tenant instead of opening past the budget', async () => {
    const resolver = resolverFor();
    if (!resolver.acquire) throw new Error('this resolver has no leases');
    const first = await resolver.acquire(refs[0] ?? '');
    const second = await resolver.acquire(refs[1] ?? '');
    await expect(resolver.acquire(refs[2] ?? '', { waitMs: 100 })).rejects.toMatchObject({
      name: 'DataPlaneCapacityError',
    });
    const rows = await probe<Array<{ datname: string }>>`
      SELECT DISTINCT datname FROM pg_stat_activity WHERE application_name = ${APPLICATION}
    `;
    expect(rows.map((row) => row.datname).sort()).toEqual([refs[0], refs[1]].sort());
    first.release();
    second.release();
    await resolver.close();
  }, 60_000);
});
