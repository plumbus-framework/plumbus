// ── Jobs Module ──
// Async capability job persistence and queue envelope types.

export { dispatchQueuedJob } from './dispatch.js';
export type { DispatchJobOptions } from './dispatch.js';
export { createJobService } from './service.js';
export type { CreateJobExecutionInput, JobService } from './service.js';
export {
  jobExecutionsTable,
  JobExecutionSource,
  JobExecutionStatus,
} from './schema.js';
export { jobEventType } from './types.js';
export type { JobExecutionRecord, JobQueuePayload } from './types.js';
export { registerJobStatusRoute } from './routes.js';
