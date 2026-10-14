import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createErrorService } from '../errors/index.js';
import type { CapabilityContract } from '../types/capability.js';
import type { EventQueue } from '../events/queue.js';
import type { LoggerService } from '../types/context.js';
import type { AuthContext } from '../types/security.js';
import { persistJobIntent, publishPendingJobs } from './pending-dispatch.js';
import type { JobExecutionSource } from './schema.js';

export interface JobDispatchService {
  /** @internal Fail before reserving an ID when no dispatcher exists. */
  assertAvailable?(): void;
  /** @internal Bind durable intent creation to the capability transaction. */
  inTransaction?(db: PostgresJsDatabase, deferred: Array<() => Promise<void>>): JobDispatchService;
  /** Enqueue a `kind: 'job'` capability by canonical name. Returns the job execution id. */
  enqueue(
    capabilityName: string,
    input: Record<string, unknown>,
    opts?: { jobId?: string },
  ): Promise<string>;
}

export interface CreateJobDispatchServiceOptions {
  logger?: Pick<LoggerService, 'error'>;
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
  transaction?: { db: PostgresJsDatabase; deferred: Array<() => Promise<void>> },
): JobDispatchService {
  const errors = createErrorService();
  return {
    inTransaction: (db, deferred) => createJobDispatchService(options, { db, deferred }),
    async enqueue(capabilityName, input, opts) {
      const capability = options.resolveCapability(capabilityName);
      if (!capability) {
        throw errors.notFound(`Capability "${capabilityName}" not found`, {
          capability: capabilityName,
        });
      }
      const id = await persistJobIntent({
        db: transaction?.db ?? options.db,
        jobQueue: options.jobQueue,
        capability,
        input,
        auth: options.auth,
        correlationId: options.getCorrelationId?.() ?? options.correlationId,
        source: options.source,
        jobId: opts?.jobId,
      });
      const publish = async () => {
        try {
          await publishPendingJobs(options.db, options.jobQueue, id, 50, options.logger);
        } catch {
          (options.logger ?? console).error(
            'Job intent persisted; publication awaits worker recovery',
            { jobId: id },
          );
        }
      };
      if (transaction) transaction.deferred.push(publish);
      else await publish();
      return id;
    },
  };
}
