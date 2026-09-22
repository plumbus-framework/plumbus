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
});
