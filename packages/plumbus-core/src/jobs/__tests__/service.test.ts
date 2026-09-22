import { describe, expect, it, vi } from 'vitest';
import { JobExecutionStatus } from '../schema.js';
import { createJobService, JobClaimResult } from '../service.js';

function mockDbForClaim(options: {
  getByIdRows: Record<string, unknown>[];
  markRunningRowsAffected?: number;
  reclaimRowsAffected?: number;
}) {
  let getByIdCall = 0;
  const getByIdRows = [...options.getByIdRows];
  let updateCall = 0;

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(async () => {
            const row = getByIdRows[getByIdCall];
            getByIdCall += 1;
            return row ? [row] : [];
          }),
        }),
      }),
    }),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(async () => {
          updateCall += 1;
          if (updateCall === 1) {
            return { rowCount: options.markRunningRowsAffected ?? 0 };
          }
          return { rowCount: options.reclaimRowsAffected ?? 0 };
        }),
      }),
    })),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  } as never;
}

describe('createJobService tryClaimForExecution', () => {
  it('returns claimed when markRunning succeeds', async () => {
    const db = mockDbForClaim({
      getByIdRows: [],
      markRunningRowsAffected: 1,
    });
    const jobs = createJobService(db);

    await expect(jobs.tryClaimForExecution('job-1', 30_000)).resolves.toBe(JobClaimResult.Claimed);
  });

  it('returns terminal for completed jobs', async () => {
    const db = mockDbForClaim({
      getByIdRows: [
        {
          id: 'job-2',
          capabilityDomain: 'ops',
          capabilityName: 'sync',
          status: JobExecutionStatus.Completed,
          source: 'http',
          createdAt: new Date(),
        },
      ],
      markRunningRowsAffected: 0,
    });
    const jobs = createJobService(db);

    await expect(jobs.tryClaimForExecution('job-2', 30_000)).resolves.toBe(JobClaimResult.Terminal);
  });

  it('returns retry for recently running jobs', async () => {
    const db = mockDbForClaim({
      getByIdRows: [
        {
          id: 'job-3',
          capabilityDomain: 'ops',
          capabilityName: 'sync',
          status: JobExecutionStatus.Running,
          startedAt: new Date(),
          source: 'http',
          createdAt: new Date(),
        },
      ],
      markRunningRowsAffected: 0,
    });
    const jobs = createJobService(db);

    await expect(jobs.tryClaimForExecution('job-3', 30_000)).resolves.toBe(JobClaimResult.Retry);
  });

  it('reclaims stale running jobs', async () => {
    const staleStartedAt = new Date(Date.now() - 60_000);
    const db = mockDbForClaim({
      getByIdRows: [
        {
          id: 'job-4',
          capabilityDomain: 'ops',
          capabilityName: 'sync',
          status: JobExecutionStatus.Running,
          startedAt: staleStartedAt,
          source: 'http',
          createdAt: new Date(),
        },
      ],
      markRunningRowsAffected: 0,
      reclaimRowsAffected: 1,
    });
    const jobs = createJobService(db);

    await expect(jobs.tryClaimForExecution('job-4', 30_000)).resolves.toBe(JobClaimResult.Claimed);
    expect(db.update).toHaveBeenCalledTimes(2);
  });
});
