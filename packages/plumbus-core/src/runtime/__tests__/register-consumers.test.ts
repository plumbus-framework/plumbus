import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { EntityRegistry } from '../../data/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { defineCapability } from '../../define/index.js';
import { JobExecutionStatus } from '../../jobs/schema.js';
import { TrustedReplayActor } from '../../types/event.js';
import { registerCapabilityConsumers } from '../register-consumers.js';

const jobCap = defineCapability({
  name: 'syncData',
  domain: 'ops',
  kind: 'job',
  description: 'Sync data',
  input: z.object({ id: z.string() }),
  output: z.object({ done: z.boolean() }),
  access: { public: true },
  effects: { data: [], events: [], external: [] },
  handler: async () => ({ done: true }),
});

function mockDb(jobRow: Record<string, unknown>) {
  const stub = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([jobRow]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }),
    }),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(stub)),
  };
  return stub as never;
}

const eventHandlerCap = defineCapability({
  name: 'onOrderPlaced',
  domain: 'orders',
  kind: 'eventHandler',
  description: 'Handle order placed',
  trigger: { event: 'order.placed' },
  input: z.object({ orderId: z.string() }),
  output: z.object({ ok: z.boolean() }),
  access: { public: true },
  effects: { data: [], events: [], external: [] },
  handler: async () => ({ ok: true }),
});

function mockOutboxDb(outboxRow: Record<string, unknown> | null) {
  const stub = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(outboxRow ? [outboxRow] : []),
        }),
      }),
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(stub)),
  };
  return stub as never;
}

describe('registerCapabilityConsumers eventHandler tenant binding', () => {
  it('rejects delivery when outbox row is missing (fail closed)', async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register(eventHandlerCap);
    const consumers = new ConsumerRegistry();
    const entities = new EntityRegistry();
    const events = new EventRegistry();

    registerCapabilityConsumers({
      capabilities,
      consumers,
      events,
      entities,
      db: mockOutboxDb(null),
      config: { environment: 'test' } as never,
    });

    const consumer = consumers.getById('onOrderPlaced');
    await expect(
      consumer?.handler({
        id: 'forged-1',
        eventType: 'order.placed',
        version: '1',
        occurredAt: new Date(),
        actor: 'attacker',
        tenantId: 'tenant-evil',
        correlationId: 'c1',
        payload: { orderId: 'o1' },
      }),
    ).rejects.toThrow('no outbox row');
  });

  it('allows trusted ops replay without outbox row when tenant is present', async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register(eventHandlerCap);
    const consumers = new ConsumerRegistry();
    const entities = new EntityRegistry();
    const events = new EventRegistry();

    registerCapabilityConsumers({
      capabilities,
      consumers,
      events,
      entities,
      db: mockOutboxDb(null),
      config: { environment: 'test' } as never,
    });

    const consumer = consumers.getById('onOrderPlaced');
    await expect(
      consumer?.handler({
        id: 'dlq-retry-1',
        eventType: 'order.placed',
        version: '1',
        occurredAt: new Date(),
        actor: TrustedReplayActor.OpsRetry,
        tenantId: 'tenant-a',
        correlationId: 'c1',
        payload: { orderId: 'o1' },
      }),
    ).resolves.toBeUndefined();
  });

  it('uses outbox tenant when row exists', async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register(eventHandlerCap);
    const consumers = new ConsumerRegistry();
    const entities = new EntityRegistry();
    const events = new EventRegistry();

    registerCapabilityConsumers({
      capabilities,
      consumers,
      events,
      entities,
      db: mockOutboxDb({ tenantId: 'tenant-db', eventType: 'order.placed' }),
      config: { environment: 'test' } as never,
    });

    const consumer = consumers.getById('onOrderPlaced');
    await consumer?.handler({
      id: 'evt-1',
      eventType: 'order.placed',
      version: '1',
      occurredAt: new Date(),
      actor: 'system',
      tenantId: 'tenant-db',
      correlationId: 'c1',
      payload: { orderId: 'o1' },
    });
  });
});

describe('registerCapabilityConsumers job security', () => {
  it('uses auth snapshot from DB and ignores queue payload auth', async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register(jobCap);
    const consumers = new ConsumerRegistry();
    const entities = new EntityRegistry();
    entities.registerAll([]);
    const events = new EventRegistry();
    events.registerAll([]);

    const db = mockDb({
      id: 'job-1',
      capabilityDomain: 'ops',
      capabilityName: 'syncData',
      status: JobExecutionStatus.Queued,
      inputJson: { id: 'x' },
      authSnapshotJson: {
        userId: 'real-user',
        roles: ['admin'],
        scopes: [],
        provider: 'db',
        tenantId: 'tenant-a',
      },
      tenantId: 'tenant-a',
    });

    registerCapabilityConsumers({
      capabilities,
      consumers,
      events,
      entities,
      db,
      config: { environment: 'test' } as never,
    });

    const consumer = consumers.getById('job:ops:syncData');
    expect(consumer).toBeDefined();

    await consumer?.handler({
      id: 'env-1',
      eventType: 'job.ops.syncData',
      version: '1',
      occurredAt: new Date(),
      actor: 'attacker',
      tenantId: 'tenant-b',
      correlationId: 'c1',
      payload: {
        jobExecutionId: 'job-1',
        input: { id: 'x' },
        capability: { domain: 'ops', name: 'syncData' },
        source: 'http',
        auth: {
          userId: 'attacker',
          roles: ['admin'],
          scopes: [],
          provider: 'queue',
          tenantId: 'tenant-b',
        },
      },
    });

    expect(db.update).toHaveBeenCalled();
  });

  it('throws when markRunning loses claim so the worker retries delivery', async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register(jobCap);
    const consumers = new ConsumerRegistry();
    const entities = new EntityRegistry();
    const events = new EventRegistry();

    const db = mockDb({
      id: 'job-2',
      capabilityDomain: 'ops',
      capabilityName: 'syncData',
      status: JobExecutionStatus.Running,
      startedAt: new Date(),
      inputJson: { id: 'x' },
      authSnapshotJson: {
        userId: 'u',
        roles: [],
        scopes: [],
        provider: 'test',
      },
    });
    db.update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ rowCount: 0 }),
      }),
    });

    registerCapabilityConsumers({
      capabilities,
      consumers,
      events,
      entities,
      db,
      config: { environment: 'test', queue: { visibilityTimeoutSec: 30 } } as never,
    });

    const consumer = consumers.getById('job:ops:syncData');
    await expect(
      consumer?.handler({
        id: 'env-2',
        eventType: 'job.ops.syncData',
        version: '1',
        occurredAt: new Date(),
        actor: 'system',
        correlationId: 'c2',
        payload: {
          jobExecutionId: 'job-2',
          input: { id: 'x' },
          capability: { domain: 'ops', name: 'syncData' },
          source: 'http',
        },
      }),
    ).rejects.toThrow('claim failed — will retry');
  });

  it('acks duplicate delivery when job is already terminal', async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register(jobCap);
    const consumers = new ConsumerRegistry();
    const entities = new EntityRegistry();
    const events = new EventRegistry();

    const db = mockDb({
      id: 'job-3',
      capabilityDomain: 'ops',
      capabilityName: 'syncData',
      status: JobExecutionStatus.Completed,
      inputJson: { id: 'x' },
      authSnapshotJson: {
        userId: 'u',
        roles: [],
        scopes: [],
        provider: 'test',
      },
    });
    db.update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ rowCount: 0 }),
      }),
    });

    registerCapabilityConsumers({
      capabilities,
      consumers,
      events,
      entities,
      db,
      config: { environment: 'test', queue: { visibilityTimeoutSec: 30 } } as never,
    });

    const consumer = consumers.getById('job:ops:syncData');
    await consumer?.handler({
      id: 'env-3',
      eventType: 'job.ops.syncData',
      version: '1',
      occurredAt: new Date(),
      actor: 'system',
      correlationId: 'c3',
      payload: {
        jobExecutionId: 'job-3',
        input: { id: 'x' },
        capability: { domain: 'ops', name: 'syncData' },
        source: 'http',
      },
    });

    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
