import type { AuthContext } from '../types/security.js';
import type { JobExecutionSource, JobExecutionStatus } from './schema.js';

/** Structured job queue envelope payload for kind: 'job' capabilities. Auth is never trusted from the queue — loaded from job_executions.auth_snapshot_json at dequeue. */
export interface JobQueuePayload {
  input: Record<string, unknown>;
  capability: { domain: string; name: string };
  jobExecutionId: string;
  source: JobExecutionSource;
}

export interface JobExecutionRecord {
  id: string;
  capabilityDomain: string;
  capabilityName: string;
  status: JobExecutionStatus;
  inputJson?: unknown;
  outputJson?: unknown;
  errorJson?: unknown;
  authSnapshotJson?: AuthContext;
  tenantId?: string | null;
  correlationId?: string | null;
  source: JobExecutionSource;
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export function jobEventType(domain: string, name: string): string {
  return `job.${domain}.${name}`;
}
