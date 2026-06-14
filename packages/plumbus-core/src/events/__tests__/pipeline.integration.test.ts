import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConsumerRegistry } from '../consumer-registry.js';
import { createOutboxDispatcher } from '../dispatcher.js';
import { createInMemoryQueue } from '../queue.js';
import { createEventWorker } from '../worker.js';
import { createPlumbusMetrics } from '../../observability/metrics.js';

describe('event pipeline integration', () => {
  it('dispatches outbox row to queue and delivers to consumer', async () => {
    const queue = createInMemoryQueue();
    const consumers = new ConsumerRegistry();
    const handled: string[] = [];

    consumers.register({
      id: 'test-consumer',
      eventTypes: ['order.placed'],
      handler: async (envelope) => {
        handled.push(envelope.id);
      },
    });

    const outboxRow = {
      id: 'evt-100',
      eventType: 'order.placed',
      version: '1',
      payload: { orderId: 'o1' },
      actor: 'user-1',
      tenantId: 'tenant-1',
      correlationId: 'corr-1',
      causationId: null,
      occurredAt: new Date(),
      status: 'pending',
      retryCount: '0',
      dispatchedAt: null,
      lastError: null,
    };

    const selectChain = (rows: unknown[]) => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            orderBy: () => Promise.resolve(rows),
          }),
        }),
      }),
    });

    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([outboxRow]))
        .mockReturnValueOnce(selectChain([])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              returning: vi.fn().mockResolvedValue([{ id: outboxRow.id }]),
            })
            .mockResolvedValueOnce({ rowCount: 1 }),
        }),
      }),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    } as never;

    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const metrics = createPlumbusMetrics();
    const idempotency = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };

    const dispatcher = createOutboxDispatcher({ db, queue, audit: audit as never, metrics });
    const worker = createEventWorker({
      db,
      queue,
      consumers,
      idempotency: idempotency as never,
      audit: audit as never,
      metrics,
    });

    worker.start();
    const dispatched = await dispatcher.poll();
    expect(dispatched).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handled).toContain('evt-100');
    expect(audit.record).toHaveBeenCalledWith(
      'event.dispatch.dispatched',
      expect.objectContaining({ eventId: 'evt-100' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'event.consumer.delivered',
      expect.objectContaining({ eventId: 'evt-100', consumerId: 'test-consumer' }),
    );

    worker.stop();
  });
});

describe('runtime compatibility regressions', () => {
  it('start without Redis uses in-memory queues', async () => {
    const { resolveRuntimeQueues } = await import('../../runtime/queue-factory.js');
    const queues = await resolveRuntimeQueues(
      {
        environment: 'production',
        queue: { host: 'localhost', port: 6379 },
      } as never,
      { preferInMemory: true },
    );
    expect(queues.isDurable).toBe(false);
    await queues.close();
  });

  it('manual consumer registration skips auto eventHandler', async () => {
    const { registerCapabilityConsumers } = await import('../../runtime/register-consumers.js');
    const { defineCapability } = await import('../../define/index.js');
    const cap = defineCapability({
      name: 'manualHandler',
      domain: 'x',
      kind: 'eventHandler',
      description: 'manual',
      trigger: { event: 'x.evt' },
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: { public: true },
      effects: { data: [], events: [], external: [] },
      handler: async () => ({ ok: true }),
    });
    const capabilities = new (
      await import('../../execution/capability-registry.js')
    ).CapabilityRegistry();
    capabilities.register(cap);
    const consumers = new ConsumerRegistry();
    consumers.register({
      id: 'manualHandler',
      eventTypes: ['x.evt'],
      handler: async () => {},
    });
    registerCapabilityConsumers({
      capabilities,
      consumers,
      events: new (await import('../../events/registry.js')).EventRegistry(),
      entities: new (await import('../../data/registry.js')).EntityRegistry(),
      db: { select: vi.fn() } as never,
      config: { environment: 'test' } as never,
    });
    expect(consumers.getAll()).toHaveLength(1);
  });

  it('needsWorkerPool is false for sync-only apps', async () => {
    const { needsWorkerPool } = await import('../../runtime/bootstrap.js');
    expect(
      needsWorkerPool({
        capabilities: [{ kind: 'action', name: 'x', domain: 'd' } as never],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(false);
  });

  it('needsJobQueuePublish is true only when job capabilities exist', async () => {
    const { needsJobQueuePublish } = await import('../../runtime/bootstrap.js');
    expect(
      needsJobQueuePublish({
        capabilities: [{ kind: 'job', name: 'x', domain: 'd' } as never],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(true);
  });
});
