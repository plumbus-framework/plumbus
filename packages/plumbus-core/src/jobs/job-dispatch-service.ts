import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createErrorService } from '../errors/index.js';
import type { CapabilityContract } from '../types/capability.js';
import type { EventQueue } from '../events/queue.js';
import type { AuthContext } from '../types/security.js';
import { dispatchQueuedJob } from './dispatch.js';
import type { JobExecutionSource } from './schema.js';

export interface JobDispatchService {
  /** Enqueue a `kind: 'job'` capability by canonical name. Returns the job execution id. */
  enqueue(
    capabilityName: string,
    input: Record<string, unknown>,
    opts?: { jobId?: string },
  ): Promise<string>;
}

export interface CreateJobDispatchServiceOptions {
  db: PostgresJsDatabase;
  jobQueue: EventQueue;
  resolveCapability: (name: string) => CapabilityContract | undefined;
  auth: AuthContext;
  /** Static correlation id, or omit and use getCorrelationId for lazy resolution. */
  correlationId?: string;
  /** Lazy correlation/causation id — preferred for HTTP so it reflects the executing capability. */
  getCorrelationId?: () => string | undefined;
  source?: (typeof JobExecutionSource)[keyof typeof JobExecutionSource];
}

export function createJobDispatchService(
  options: CreateJobDispatchServiceOptions,
): JobDispatchService {
  const errors = createErrorService();
  return {
    async enqueue(capabilityName, input, opts) {
      const capability = options.resolveCapability(capabilityName);
      if (!capability) {
        throw errors.notFound(`Capability "${capabilityName}" not found`, {
          capability: capabilityName,
        });
      }
      return dispatchQueuedJob({
        db: options.db,
        jobQueue: options.jobQueue,
        capability,
        input,
        auth: options.auth,
        correlationId: options.getCorrelationId?.() ?? options.correlationId,
        source: options.source,
        jobId: opts?.jobId,
      });
    },
  };
}
