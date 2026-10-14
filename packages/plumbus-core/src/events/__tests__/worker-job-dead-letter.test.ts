import { describe, expect, it, vi } from 'vitest';
import { createEventWorker } from '../worker.js';
import { createInMemoryQueue } from '../queue.js';
import { ConsumerRegistry } from '../consumer-registry.js';
import { JobExecutionStatus } from '../../jobs/schema.js';

describe('createEventWorker job dead-letter', () => {
  it('marks job_executions dead_lettered when job consumer exhausts retries', async () => {
    const consumers = new ConsumerRegistry();
    consumers.register({
      id: 'job:ops:sync',
      eventTypes: ['job.ops.sync'],
      maxRetries: 1,
      handler: async () => {
        throw new Error('boom');
      },
    });

    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowCount: 1 }),
        }),
      }),
      select: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    } as never;

    const idempotency = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };

    const worker = createEventWorker({
      db,
      queue: createInMemoryQueue(),
      consumers,
      idempotency: idempotency as never,
      defaultMaxRetries: 1,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 1,
    });

    await worker.deliver({
      id: 'evt-1',
      eventType: 'job.ops.sync',
      version: '1',
      occurredAt: new Date(),
      actor: 'system',
      correlationId: 'c1',
      payload: {
        jobExecutionId: 'job-99',
        input: {},
        capability: { domain: 'ops', name: 'sync' },
        source: 'http',
      },
    });

    expect(db.insert).toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
    const setCall = db.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setCall?.status).toBe(JobExecutionStatus.DeadLettered);
  });

  // A tenant envelope dead-letters on its plane; the job row is marked there when the plane holds
  // it (HTTP-enqueued jobs) and on the pool otherwise (jobs a pool-database unit enqueued, as
  // under unitDataPlane 'control-plane': the job consumer reads the pool).
  it.each([
    ['tenant plane', 1, 0],
    ['pool, when the tenant plane holds no such job', 0, 1],
  ] as const)('marks a tenant job dead_lettered on the %s', async (_where, tenantRows, poolMarks) => {
    const consumers = new ConsumerRegistry();
    consumers.register({
      id: 'job:ops:sync',
      eventTypes: ['job.ops.sync'],
      maxRetries: 1,
      handler: async () => {
        throw new Error('boom');
      },
    });
    const makeDb = (rowCount: number) =>
      ({
        // The tenant plane's idempotency lookup: nothing processed yet.
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowCount }) }),
        }),
      }) as never as {
        insert: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
    const pool = makeDb(1);
    const tenant = makeDb(tenantRows);
    const worker = createEventWorker({
      db: pool as never,
      queue: createInMemoryQueue(),
      consumers,
      idempotency: { isProcessed: vi.fn(async () => false), markProcessed: vi.fn() } as never,
      resolver: {
        resolve: async (tenantRef: string) => ({
          db: tenant as never,
          coreSchema: 'core_plumbus',
          packageSchemaPrefix: 'pkg_',
          tenantRef,
        }),
      },
      defaultMaxRetries: 1,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 1,
    });

    await worker.deliver({
      id: 'evt-2',
      eventType: 'job.ops.sync',
      version: '1',
      occurredAt: new Date(),
      actor: 'system',
      correlationId: 'c2',
      tenantId: 'tenant-a',
      payload: {
        jobExecutionId: 'job-100',
        input: {},
        capability: { domain: 'ops', name: 'sync' },
        source: 'flow',
      },
    });

    expect(tenant.insert).toHaveBeenCalled();
    expect(pool.insert).not.toHaveBeenCalled();
    expect(tenant.update).toHaveBeenCalledTimes(1);
    expect(pool.update).toHaveBeenCalledTimes(poolMarks);
    const markedOn = poolMarks ? pool : tenant;
    const marked = markedOn.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(marked?.status).toBe(JobExecutionStatus.DeadLettered);
  });
});
