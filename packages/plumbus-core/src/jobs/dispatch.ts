import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { evaluateAccess } from '../execution/authorization.js';
import type { CapabilityContract } from '../types/capability.js';
import type { EventQueue } from '../events/queue.js';
import type { AuthContext } from '../types/security.js';
import { createJobService } from './service.js';
import { JobExecutionSource } from './schema.js';
import { jobEventType, type JobQueuePayload } from './types.js';

export interface DispatchJobOptions {
  db: PostgresJsDatabase;
  jobQueue: EventQueue;
  capability: CapabilityContract;
  input: Record<string, unknown>;
  auth: AuthContext;
  jobId?: string;
  source?: (typeof JobExecutionSource)[keyof typeof JobExecutionSource];
  correlationId?: string;
}

/** Create job_executions row and publish to the jobs queue. */
export async function dispatchQueuedJob(options: DispatchJobOptions): Promise<string> {
  const {
    db,
    jobQueue,
    capability,
    input,
    auth,
    jobId = crypto.randomUUID(),
    source = JobExecutionSource.Http,
    correlationId,
  } = options;

  if (capability.kind !== 'job') {
    throw new Error(`Capability "${capability.name}" is not kind job`);
  }

  const authz = evaluateAccess(capability.access, auth);
  if (!authz.allowed) {
    throw new Error(authz.reason ?? 'Job access denied at enqueue');
  }

  const jobs = createJobService(db);
  await jobs.create({
    id: jobId,
    capabilityDomain: capability.domain,
    capabilityName: capability.name,
    input,
    auth,
    correlationId: correlationId ?? jobId,
    source,
  });

  const payload: JobQueuePayload = {
    input,
    capability: { domain: capability.domain, name: capability.name },
    jobExecutionId: jobId,
    source,
  };

  try {
    await jobQueue.publish({
      id: jobId,
      eventType: jobEventType(capability.domain, capability.name),
      version: '1',
      occurredAt: new Date(),
      actor: auth.userId ?? 'anonymous',
      tenantId: auth.tenantId,
      correlationId: correlationId ?? jobId,
      payload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await jobs.markPublishFailed(jobId, { code: 'queue_publish_failed', message });
    throw err;
  }

  return jobId;
}
