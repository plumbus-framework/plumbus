import type { JobDispatchService } from './job-dispatch-service.js';

/**
 * Wraps JobDispatchService so `enqueue` schedules work after the active transaction commits.
 * Returns a pre-allocated job id immediately so handlers can await without deadlocking the tx.
 */
export function createDeferredJobDispatchService(
  jobs: JobDispatchService,
  deferred: Array<() => Promise<void>>,
  allocJobId: () => string = () => crypto.randomUUID(),
): JobDispatchService {
  return {
    async enqueue(capabilityName, input, opts) {
      const jobId = opts?.jobId ?? allocJobId();
      deferred.push(async () => {
        await jobs.enqueue(capabilityName, input, { jobId });
      });
      return jobId;
    },
  };
}
