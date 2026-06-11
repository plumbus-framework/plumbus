import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineCapability } from '../../define/index.js';
import { createInMemoryQueue } from '../../events/queue.js';
import { dispatchQueuedJob } from '../dispatch.js';
import { JobExecutionStatus } from '../schema.js';
import { createJobService } from '../service.js';

const jobCap = defineCapability({
  name: 'processOrder',
  domain: 'orders',
  kind: 'job',
  description: 'Process order async',
  input: z.object({ orderId: z.string() }),
  output: z.object({ ok: z.boolean() }),
  access: { public: true },
  effects: { data: [], events: [], external: [] },
  handler: async () => ({ ok: true }),
});

describe('dispatchQueuedJob', () => {
  it('marks job failed when queue publish fails after DB insert', async () => {
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: 'job-1',
              capabilityDomain: 'orders',
              capabilityName: 'processOrder',
              status: JobExecutionStatus.Queued,
              inputJson: { orderId: 'o1' },
              authSnapshotJson: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
              tenantId: 't1',
              correlationId: 'job-1',
              source: 'http',
              createdAt: new Date(),
            },
          ]),
        }),
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

    const jobQueue = createInMemoryQueue();
    vi.spyOn(jobQueue, 'publish').mockRejectedValue(new Error('redis down'));

    await expect(
      dispatchQueuedJob({
        db,
        jobQueue,
        capability: jobCap,
        input: { orderId: 'o1' },
        auth: { userId: 'u1', roles: [], scopes: [], provider: 'test', tenantId: 't1' },
        jobId: 'job-1',
      }),
    ).rejects.toThrow('redis down');

    expect(db.update).toHaveBeenCalled();
  });
});

describe('createJobService.markRunning', () => {
  it('returns false when job is not queued', async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowCount: 0 }),
        }),
      }),
    } as never;
    const jobs = createJobService(db);
    const claimed = await jobs.markRunning('job-1');
    expect(claimed).toBe(false);
  });
});
