// ── Worker Module ──
// Background worker pool: processes async jobs and event-driven workloads.
//
// Key exports: createWorkerPool

export { assertFlowLeaseColumns, createWorkerPool } from './bootstrap.js';
export type { WorkerPool, WorkerPoolConfig } from './bootstrap.js';
