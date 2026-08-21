import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPlan02Harness, type Plan02Harness } from '../../durable/harness.js';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { ConsumerRegistry } from '../consumer-registry.js';
import { createIdempotencyService } from '../idempotency.js';
import { createInMemoryQueue } from '../queue.js';
import { createEventWorker } from '../worker.js';

describe('Event worker + idempotency on a tenant data plane', () => {
  let harness: Plan02Harness;

  afterAll(async () => {
    await harness?.close();
  });

  it('records idempotency and dead-letter on the tenant db, not the spine', async () => {
    harness = await createPlan02Harness({ includeEventDelivery: true });
    const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
      coreSchema: harness.coreSchema,
    });
    const consumers = new ConsumerRegistry();
    let hits = 0;
    consumers.register({
      id: 'c-tenant',
      eventTypes: ['order.created'],
      maxRetries: 1,
      handler: async () => {
        hits += 1;
        if (hits === 1) throw new Error('first fail');
      },
    });

    const worker = createEventWorker({
      db: harness.spineDb,
      queue: createInMemoryQueue(),
      consumers,
      idempotency: createIdempotencyService(harness.spineDb),
      resolver,
    });

    const envelope = {
      id: 'evt-tenant-1',
      eventType: 'order.created',
      version: '1',
      occurredAt: new Date(),
      actor: 'user-1',
      tenantId: 'tenant-a',
      correlationId: 'corr-1',
      payload: { orderId: '1' },
    };

    await worker.deliver(envelope);
    const dead = await harness.tenantDb.execute(sql`
      SELECT event_id FROM event_dead_letter WHERE event_id = 'evt-tenant-1'
    `);
    expect((dead as unknown as unknown[]).length).toBe(1);
    const spineDead = await harness.spineDb.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'event_dead_letter'
    `);
    expect((spineDead as unknown as unknown[]).length).toBe(0);

    consumers.register({
      id: 'c-ok',
      eventTypes: ['order.ok'],
      handler: async () => undefined,
    });
    const ok = { ...envelope, id: 'evt-ok', eventType: 'order.ok' };
    await worker.deliver(ok);
    await worker.deliver(ok);
    const idemp = await harness.tenantDb.execute(sql`
      SELECT event_id FROM event_idempotency WHERE event_id = 'evt-ok'
    `);
    expect((idemp as unknown as unknown[]).length).toBe(1);
  });
});
