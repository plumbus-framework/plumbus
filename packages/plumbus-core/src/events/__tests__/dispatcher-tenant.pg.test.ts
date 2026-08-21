import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import type { DataPlaneResolver } from '../../tenancy/types.js';
import {
  createPlan02Database,
  createPlan02Harness,
  type Plan02Harness,
} from '../../durable/harness.js';
import { eventOutboxDdl, tenantDurableDdl } from '../../durable/apply-ddl.js';
import { persistAcceptanceOnDb } from '../../durable/postgres-persist.js';
import { createOutboxDispatcher } from '../dispatcher.js';
import { createInMemoryQueue } from '../queue.js';

describe('Per-tenant outbox pump on two real databases', () => {
  let harness: Plan02Harness;
  let tenant2: { name: string; db: Plan02Harness['tenantDb']; close(): Promise<void> };

  afterAll(async () => {
    await tenant2?.close();
    await harness?.close();
  });

  it('drains event_outbox and dispatch_outbox per resolved tenant', async () => {
    harness = await createPlan02Harness({ includeEventOutbox: true });
    tenant2 = await createPlan02Database({
      admin: harness.admin,
      kind: 'tenant',
      ddl: `${tenantDurableDdl(harness.coreSchema)}\n${eventOutboxDdl()}`,
    });

    await harness.tenantDb.execute(sql`
      INSERT INTO event_outbox (event_type, version, payload, actor, tenant_id, correlation_id, status)
      VALUES ('order.created', '1', '{"id":"a"}'::jsonb, 'user', 'tenant-a', 'corr-a', 'pending')
    `);
    await tenant2.db.execute(sql`
      INSERT INTO event_outbox (event_type, version, payload, actor, tenant_id, correlation_id, status)
      VALUES ('order.created', '1', '{"id":"b"}'::jsonb, 'user', 'tenant-b', 'corr-b', 'pending')
    `);

    const nowIso = new Date().toISOString();
    await persistAcceptanceOnDb(
      harness.tenantDb,
      {
        executionId: 'exec-pump-a',
        tenantRef: 'tenant-a',
        definitionId: 'flow:demo',
        definitionVersion: '1.0.0',
        firstStepId: 'step-a',
        correlationId: 'corr-a',
        nowIso,
      },
      harness.coreSchema,
    );

    const published: string[] = [];
    const queue = createInMemoryQueue();
    queue.subscribe(async (event) => {
      published.push(event.tenantId ?? '');
    });

    const resolver: DataPlaneResolver = {
      resolve: async (tenantRef: string) => {
        if (tenantRef === 'tenant-a') {
          return createSingleDataPlaneResolver(harness.tenantDb, {
            coreSchema: harness.coreSchema,
          }).resolve(tenantRef);
        }
        if (tenantRef === 'tenant-b') {
          return createSingleDataPlaneResolver(tenant2.db, {
            coreSchema: harness.coreSchema,
          }).resolve(tenantRef);
        }
        throw new Error(`unknown tenant ${tenantRef}`);
      },
    };

    const dispatcher = createOutboxDispatcher({
      db: harness.spineDb,
      queue,
      resolver,
      listTenantRefs: async () => ['tenant-a', 'tenant-b'],
      spineDb: harness.spineDb,
    });

    const count = await dispatcher.poll();
    expect(count).toBeGreaterThanOrEqual(3);
    expect(published.sort()).toEqual(['tenant-a', 'tenant-b']);

    const spineRows = await harness.spineDb.execute(sql`
      SELECT execution_id FROM opaque_dispatch WHERE execution_id = 'exec-pump-a'
    `);
    expect((spineRows as unknown as unknown[]).length).toBe(1);
  });
});
