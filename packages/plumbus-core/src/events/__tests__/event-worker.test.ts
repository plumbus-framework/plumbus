import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '../../types/event.js';
import { ConsumerRegistry } from '../consumer-registry.js';
import { createInMemoryQueue } from '../queue.js';
import { createEventWorker } from '../worker.js';

function makeEnvelope(overrides?: Partial<EventEnvelope>): EventEnvelope {
  return {
    id: 'evt-1',
    eventType: 'order.created',
    version: '1',
    occurredAt: new Date(),
    actor: 'user-1',
    correlationId: 'corr-1',
    payload: { orderId: '123' },
    ...overrides,
  };
}

function mockIdempotency() {
  const processed = new Set<string>();
  return {
    isProcessed: vi.fn(async (eventId: string, consumerId: string) =>
      processed.has(`${eventId}:${consumerId}`),
    ),
    markProcessed: vi.fn(async (eventId: string, consumerId: string) => {
      processed.add(`${eventId}:${consumerId}`);
    }),
  };
}

function mockDb() {
  const deadLetterRows: any[] = [];
  return {
    _deadLetterRows: deadLetterRows,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: any) => {
        deadLetterRows.push(row);
        return Promise.resolve();
      }),
    }),
  } as any;
}

describe('EventWorker', () => {
  it('delivers events to matching consumers', async () => {
    const consumers = new ConsumerRegistry();
    const handled: string[] = [];
    consumers.register({
      id: 'c1',
      eventTypes: ['order.created'],
      handler: async (env) => {
        handled.push(env.id);
      },
    });

    const worker = createEventWorker({
      db: mockDb(),
      queue: createInMemoryQueue(),
      consumers,
      idempotency: mockIdempotency(),
    });

    await worker.deliver(makeEnvelope());
    expect(handled).toEqual(['evt-1']);
  });

  it('skips already-processed events (idempotency)', async () => {
    const consumers = new ConsumerRegistry();
    const handled: string[] = [];
    consumers.register({
      id: 'c1',
      eventTypes: ['order.created'],
      handler: async (env) => {
        handled.push(env.id);
      },
    });

    const idemp = mockIdempotency();
    // Pre-mark as processed
    await idemp.markProcessed('evt-1', 'c1');

    const worker = createEventWorker({
      db: mockDb(),
      queue: createInMemoryQueue(),
      consumers,
      idempotency: idemp,
    });

    await worker.deliver(makeEnvelope());
    expect(handled).toEqual([]);
  });

  it('retries on failure and marks processed on eventual success', async () => {
    const consumers = new ConsumerRegistry();
    let attempt = 0;
    consumers.register({
      id: 'c1',
      eventTypes: ['order.created'],
      maxRetries: 3,
      handler: async () => {
        attempt++;
        if (attempt < 3) throw new Error('transient');
      },
    });

    const idemp = mockIdempotency();
    const worker = createEventWorker({
      db: mockDb(),
      queue: createInMemoryQueue(),
      consumers,
      idempotency: idemp,
    });

    await worker.deliver(makeEnvelope());
    expect(attempt).toBe(3);
    expect(idemp.markProcessed).toHaveBeenCalledWith('evt-1', 'c1');
  });

  it('dead-letters events after exhausting retries', async () => {
    const consumers = new ConsumerRegistry();
    consumers.register({
      id: 'c1',
      eventTypes: ['order.created'],
      maxRetries: 2,
      handler: async () => {
        throw new Error('always fails');
      },
    });

    const db = mockDb();
    const idemp = mockIdempotency();
    const worker = createEventWorker({
      db,
      queue: createInMemoryQueue(),
      consumers,
      idempotency: idemp,
    });

    await worker.deliver(makeEnvelope());
    expect(db._deadLetterRows).toHaveLength(1);
    expect(db._deadLetterRows[0]).toMatchObject({
      eventId: 'evt-1',
      eventType: 'order.created',
      consumerId: 'c1',
      lastError: 'always fails',
    });
    // Should NOT be marked as processed
    expect(idemp.markProcessed).not.toHaveBeenCalled();
  });

  it('start/stop controls the queue subscription', async () => {
    const queue = createInMemoryQueue();
    const consumers = new ConsumerRegistry();
    const handled: string[] = [];
    consumers.register({
      id: 'c1',
      eventTypes: ['order.created'],
      handler: async (env) => {
        handled.push(env.id);
      },
    });

    const worker = createEventWorker({
      db: mockDb(),
      queue,
      consumers,
      idempotency: mockIdempotency(),
    });

    expect(worker.isRunning).toBe(false);
    worker.start();
    expect(worker.isRunning).toBe(true);

    await queue.publish(makeEnvelope());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handled).toEqual(['evt-1']);

    worker.stop();
    expect(worker.isRunning).toBe(false);
  });

  it('writes idempotency and dead-letter on the resolved tenant db', async () => {
    const consumers = new ConsumerRegistry();
    consumers.register({
      id: 'c1',
      eventTypes: ['order.created'],
      maxRetries: 1,
      handler: async () => {
        throw new Error('tenant fail');
      },
    });

    const pool = mockDb();
    const tenant = mockDb();
    const poolIdemp = mockIdempotency();
    const worker = createEventWorker({
      db: pool,
      queue: createInMemoryQueue(),
      consumers,
      idempotency: poolIdemp,
      resolver: {
        resolve: async (tenantRef: string) => {
          if (tenantRef !== 'tenant-a') throw new Error(tenantRef);
          return {
            db: tenant,
            coreSchema: 'core_plumbus',
            packageSchemaPrefix: 'pkg_',
            tenantRef,
          };
        },
      },
    });

    await worker.deliver(makeEnvelope({ tenantId: 'tenant-a' }));
    expect(tenant._deadLetterRows).toHaveLength(1);
    expect(pool._deadLetterRows).toHaveLength(0);
    expect(poolIdemp.markProcessed).not.toHaveBeenCalled();
    expect(poolIdemp.isProcessed).not.toHaveBeenCalled();
  });

  it('skips inactive subscriptions without invoking the handler or dead-lettering', async () => {
    const consumers = new ConsumerRegistry();
    const handled: string[] = [];
    consumers.register({
      id: 'c1',
      eventTypes: ['order.created'],
      capabilityVersion: '2.0.0',
      active: false,
      handler: async (env) => {
        handled.push(env.id);
      },
    });

    const db = mockDb();
    const worker = createEventWorker({
      db,
      queue: createInMemoryQueue(),
      consumers,
      idempotency: mockIdempotency(),
    });

    await worker.deliver(makeEnvelope());
    expect(handled).toEqual([]);
    expect(db._deadLetterRows).toEqual([]);
  });

  it('skips delivery when the subscription policy denies', async () => {
    const consumers = new ConsumerRegistry();
    const handled: string[] = [];
    consumers.register({
      id: 'c1',
      eventTypes: ['order.created'],
      capabilityVersion: '1.0.0',
      checkDeliveryPolicy: async () => false,
      handler: async (env) => {
        handled.push(env.id);
      },
    });

    const db = mockDb();
    const worker = createEventWorker({
      db,
      queue: createInMemoryQueue(),
      consumers,
      idempotency: mockIdempotency(),
    });

    await worker.deliver(makeEnvelope());
    expect(handled).toEqual([]);
    expect(db._deadLetterRows).toEqual([]);
  });

  it('ignores events with no matching consumers', async () => {
    const consumers = new ConsumerRegistry();
    const db = mockDb();
    const idemp = mockIdempotency();
    const worker = createEventWorker({
      db,
      queue: createInMemoryQueue(),
      consumers,
      idempotency: idemp,
    });

    // Should not throw
    await worker.deliver(makeEnvelope({ eventType: 'unknown.event' }));
    expect(db._deadLetterRows).toEqual([]);
    expect(idemp.markProcessed).not.toHaveBeenCalled();
  });
});
