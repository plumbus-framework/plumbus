// ── Worker Module ──
// Background worker pool: processes async jobs and event-driven workloads.
//
// Key exports: createWorkerPool

export { assertFlowLeaseColumns, createWorkerPool, DEFAULT_FLOW_CONCURRENCY } from './bootstrap.js';
export type { WorkerPool, WorkerPoolConfig, WorkerPoolStopOptions } from './bootstrap.js';
export { FlowLaneKind } from './flow-lanes.js';
export type { FlowLaneEntry, FlowLaneFull, FlowLaneSnapshot } from './flow-lanes.js';
