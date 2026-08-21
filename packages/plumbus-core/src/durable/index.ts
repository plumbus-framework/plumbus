// Durable dispatch core — Protocol A tenant state, persist-before-ack, and
// opaque spine records. Not exported from the public @plumbus/core barrel yet;
// the existing flows engine still owns live execution. Stage 3 wires this in.

export {
  createMemorySpineStore,
  createMemoryTenantStore,
  spineDispatchKey,
} from './memory-store.js';
export type { MemorySpineStore, MemoryTenantStore, TenantTx } from './memory-store.js';
export {
  assertOpaqueDispatch,
  createOpaqueDispatchRecord,
  spineRecordFromUnknown,
} from './opaque-dispatch.js';
export {
  assertCasCommitted,
  persistAcceptance,
  persistRetrySchedule,
  persistStepCompletion,
} from './persist-before-ack.js';
export type {
  AcceptInput,
  PersistAcceptanceResult,
  PersistStepResult,
  RetryScheduleInput,
  StepCompletionInput,
} from './persist-before-ack.js';
export {
  publishOutboxRow,
  runSpineSweep,
  runTenantSweep,
} from './reconciliation.js';
export {
  eventDeliveryDdl,
  eventOutboxDdl,
  flowExecutionsDdl,
  PLAN02_DB_NAME_PATTERN,
  qualifyTable,
  spineDispatchDdl,
  tenantApprovalDdl,
  tenantDurableDdl,
  tenantEpochTableDdl,
} from './apply-ddl.js';
export { createPlan02Database, extraHarnessConnection, createPlan02Harness } from './harness.js';
export type { Plan02Harness } from './harness.js';
export {
  FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
  FRAMEWORK_SPINE_MIGRATIONS,
} from './migrations-path.js';
export { resolveTestPostgresAdmin } from './pg-env.js';
export type { TestPostgresAdmin } from './pg-env.js';
export {
  bumpTenantEpochOnDb,
  casAdvanceExecution,
  insertDispatchOutbox,
  listSideEffects,
  listUnpublishedOutbox,
  loadExecutionState,
  markOutboxAcked,
  markOutboxPublished,
  persistAcceptanceOnDb,
  publishOutboxToSpine,
} from './postgres-persist.js';
export {
  ackSpineDispatch,
  claimSpineDispatch,
  spineRowFromSql,
  upsertSpineDispatch,
} from './spine-claim.js';
export {
  createSpineDispatchTable,
  createTenantDurableTables,
  SPINE_DISPATCH_TABLE_NAME,
  TENANT_DURABLE_TABLE_NAMES,
} from './schema.js';
export {
  DEFAULT_PRIORITY_CLASS_ID,
  DEFAULT_WORK_CLASS_ID,
  DurableExecutionStatus,
  DurableStepStatus,
  EpochMismatchError,
  OPAQUE_DISPATCH_ALLOWED_KEYS,
  OPAQUE_DISPATCH_FORBIDDEN_KEYS,
  OPAQUE_DISPATCH_REQUIRED_KEYS,
  RevisionConflictError,
  SpineDeliveryState,
} from './types.js';
export type {
  CasResult,
  DispatchOutboxRow,
  OpaqueDispatchRecord,
  StepExecutionRecord,
  TenantExecutionState,
  TerminalStateRecord,
  WaitStateRecord,
} from './types.js';
