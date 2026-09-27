import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAuditService } from '../../audit/service.js';
import type { AuditEvent } from '../../types/audit.js';
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
            // stale-claim release, then claim, then mark dispatched
            .mockResolvedValueOnce({ rowCount: 0 })
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

describe('event pipeline with the real audit service', () => {
  function outboxRow(id: string) {
    return {
      id,
      eventType: 'order.placed',
      version: '1',
      payload: { orderId: id },
      actor: 'user-1',
      tenantId: 'tenant-1',
      correlationId: `corr-${id}`,
      causationId: null,
      occurredAt: new Date(),
      status: 'pending',
      retryCount: '0',
      dispatchedAt: null,
      lastError: null,
    };
  }

  function pipelineDb(pending: unknown[]) {
    const selectChain = (rows: unknown[]) => ({
      from: () => ({ where: () => ({ limit: () => ({ orderBy: () => Promise.resolve(rows) }) }) }),
    });
    // Release and status updates are awaited directly; the claim reads `.returning()`.
    const updateResult = () =>
      Object.assign(Promise.resolve({ rowCount: 1 }), {
        returning: () => Promise.resolve([{ id: 'claimed' }]),
      });
    const deadLetters: Record<string, unknown>[] = [];
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain(pending))
        .mockReturnValueOnce(selectChain([])),
      update: vi.fn(() => ({ set: () => ({ where: updateResult }) })),
      insert: vi.fn(() => ({
        values: (row: Record<string, unknown>) => {
          deadLetters.push(row);
          return Promise.resolve();
        },
      })),
    };
    return { db: db as never, deadLetters };
  }

  function strictAudit(write: (event: AuditEvent) => Promise<void>) {
    return createAuditService({
      db: {} as never,
      auth: { userId: 'system-worker', roles: ['system'], scopes: [], provider: 'worker' },
      component: 'event-worker',
      writer: { write },
    });
  }

  it('dispatches and delivers through createAuditService with valid outcomes', async () => {
    const written: AuditEvent[] = [];
    const audit = strictAudit(async (event) => {
      written.push(event);
    });
    const queue = createInMemoryQueue();
    const consumers = new ConsumerRegistry();
    const handled: string[] = [];
    consumers.register({
      id: 'strict-consumer',
      eventTypes: ['order.placed'],
      maxRetries: 1,
      handler: async (envelope) => {
        handled.push(envelope.id);
        if (envelope.id === 'evt-201') throw new Error('consumer refuses');
      },
    });
    const { db, deadLetters } = pipelineDb([outboxRow('evt-200'), outboxRow('evt-201')]);
    const idempotency = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const worker = createEventWorker({ db, queue, consumers, idempotency, audit, logger });
    const dispatcher = createOutboxDispatcher({ db, queue, audit, logger });

    worker.start();
    expect(await dispatcher.poll()).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    worker.stop();

    expect(handled).toEqual(['evt-200', 'evt-201']);
    expect(idempotency.markProcessed).toHaveBeenCalledWith('evt-200', 'strict-consumer');
    expect(deadLetters).toEqual([
      expect.objectContaining({ eventId: 'evt-201', consumerId: 'strict-consumer' }),
    ]);
    // Every entry reached the writer: none was refused for its outcome.
    expect(logger.error).not.toHaveBeenCalled();
    const entriesFor = (eventId: string) =>
      written
        .filter((e) => e.metadata?.eventId === eventId)
        .map((e) => `${e.action}:${e.outcome}`)
        .sort();
    expect(entriesFor('evt-200')).toEqual([
      'event.consumer.attempt:success',
      'event.consumer.delivered:success',
      'event.dispatch.attempt:success',
      'event.dispatch.dispatched:success',
    ]);
    expect(entriesFor('evt-201')).toEqual([
      'event.consumer.attempt:success',
      'event.consumer.dead_lettered:failure',
      'event.dispatch.attempt:success',
      'event.dispatch.dispatched:success',
    ]);
  });

  it('records a failed publish as a failure with its disposition', async () => {
    const written: AuditEvent[] = [];
    const audit = strictAudit(async (event) => {
      written.push(event);
    });
    const queue = {
      publish: vi.fn().mockRejectedValue(new Error('queue down')),
      subscribe: vi.fn().mockReturnValue(() => {}),
      close: vi.fn(),
    };
    const lastTry = { ...outboxRow('evt-300'), retryCount: '4' };
    const { db, deadLetters } = pipelineDb([outboxRow('evt-299'), lastTry]);
    const dispatcher = createOutboxDispatcher({ db, queue, audit, maxRetries: 5 });

    expect(await dispatcher.poll()).toBe(0);

    const failed = written.filter((e) => e.action === 'event.dispatch.failed');
    expect(failed.map((e) => [e.outcome, e.metadata?.eventId, e.metadata?.disposition])).toEqual([
      ['failure', 'evt-299', 'retry'],
      ['failure', 'evt-300', 'dead_lettered'],
    ]);
    expect(deadLetters).toEqual([expect.objectContaining({ eventId: 'evt-300' })]);
  });

  it('keeps dispatching, delivering and dead-lettering when audit writes fail', async () => {
    const audit = strictAudit(async () => {
      throw new Error('audit table unavailable');
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const queue = createInMemoryQueue();
    const consumers = new ConsumerRegistry();
    const handled: string[] = [];
    consumers.register({
      id: 'strict-consumer',
      eventTypes: ['order.placed'],
      maxRetries: 1,
      handler: async (envelope) => {
        handled.push(envelope.id);
        if (envelope.id === 'evt-401') throw new Error('consumer refuses');
      },
    });
    const { db, deadLetters } = pipelineDb([outboxRow('evt-400'), outboxRow('evt-401')]);
    const idempotency = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };
    const worker = createEventWorker({ db, queue, consumers, idempotency, audit, logger });
    const dispatcher = createOutboxDispatcher({ db, queue, audit, logger });

    worker.start();
    expect(await dispatcher.poll()).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    worker.stop();

    expect(handled).toEqual(['evt-400', 'evt-401']);
    expect(idempotency.markProcessed).toHaveBeenCalledWith('evt-400', 'strict-consumer');
    expect(deadLetters).toEqual([expect.objectContaining({ eventId: 'evt-401' })]);
    expect(logger.error).toHaveBeenCalledWith(
      'Event pipeline audit write failed',
      expect.objectContaining({ action: 'event.consumer.attempt', eventId: 'evt-400' }),
    );
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
