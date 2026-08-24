// ── Durable dispatch core (Protocol A) ──
// Tenant-DB-authoritative execution state plus a reconstructible spine hint.
// This is the v1 field subset of execution-state.schema.json / opaque-dispatch
// — not a second workflow engine. The existing flows engine will consume these
// records; it is not replaced here.
//
// Contract fields v1 does not populate:
//   ExecutionState: budgetLedgerRefId, package, policySnapshotRefId,
//     privateInput/OutputRefId, evidenceSetRefId, provenanceRefId,
//     authorizationDecisionRefId on every step, required domainOutcomeId on
//     infrastructure-failure terminals, human-task / approval / compensation
//     refs.
//   Spine: no private payload by construction (additionalProperties: false).

/** Operational states the v1 durable core persists. */
export const DurableExecutionStatus = {
  Created: 'created',
  Running: 'running',
  Waiting: 'waiting',
  RetryScheduled: 'retry-scheduled',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type DurableExecutionStatus =
  (typeof DurableExecutionStatus)[keyof typeof DurableExecutionStatus];

export const DurableStepStatus = {
  Pending: 'pending',
  Ready: 'ready',
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  RetryScheduled: 'retry-scheduled',
} as const;

export type DurableStepStatus = (typeof DurableStepStatus)[keyof typeof DurableStepStatus];

export const SpineDeliveryState = {
  Ready: 'ready',
  Leased: 'leased',
  RetryScheduled: 'retry-scheduled',
  Acknowledged: 'acknowledged',
  DeadLettered: 'dead-lettered',
} as const;

export type SpineDeliveryState = (typeof SpineDeliveryState)[keyof typeof SpineDeliveryState];

/** Tenant-local execution row (authoritative). */
export interface TenantExecutionState {
  executionId: string;
  stateRefId: string;
  tenantRef: string;
  revision: number;
  tenantEpoch: number;
  status: DurableExecutionStatus;
  definitionId: string;
  definitionVersion: string;
  currentStepId: string;
  stepIndex: number;
  attempt: number;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  wakeAt?: string;
  terminal: boolean;
}

export interface StepExecutionRecord {
  stepExecutionId: string;
  executionId: string;
  stepId: string;
  attempt: number;
  state: DurableStepStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WaitStateRecord {
  waitStateId: string;
  executionId: string;
  stepId: string;
  kind: 'timer' | 'event' | 'retry';
  state: 'waiting' | 'resumed' | 'expired' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  notBefore?: string;
  expiresAt?: string;
  resolvedAt?: string;
}

export interface TerminalStateRecord {
  terminalStateId: string;
  executionId: string;
  operationalState: 'succeeded' | 'failed' | 'cancelled';
  finalRevision: number;
  completedAt: string;
  /** Optional in v1; required in the draft contract. */
  domainOutcomeId?: string;
}

/**
 * Tenant-local dispatch-outbox row. Written in the same tenant transaction as
 * the execution-state CAS. The pump publishes a spine hint after commit.
 */
export interface DispatchOutboxRow {
  outboxId: string;
  executionId: string;
  stateRefId: string;
  expectedRevision: number;
  tenantEpoch: number;
  tenantRef: string;
  stepId: string;
  definitionId: string;
  definitionVersion: string;
  correlationId: string;
  workClassId: string;
  priorityClassId: string;
  notBefore: string;
  createdAt: string;
  publishedAt?: string;
  spineRowId?: string;
  spineAckedAt?: string;
  superseded: boolean;
}

/**
 * Spine OpaqueDispatchRecord — scheduling hint only.
 * Must stay valid against contracts/tenancy/opaque-dispatch.schema.json
 * (`additionalProperties: false`).
 */
export interface OpaqueDispatchRecord {
  contractVersion: '0.1.0';
  dispatchId: string;
  tenantRouteId: string;
  executionId: string;
  definitionId: string;
  definitionVersion: string;
  stepId: string;
  tenantExecutionStateRefId: string;
  expectedRevision: number;
  tenantEpoch: number;
  workClassId: string;
  priorityClassId: string;
  deliveryState: SpineDeliveryState;
  attempt: number;
  notBefore: string;
  leaseRefId?: string;
  leaseExpiresAt?: string;
  privacySafeFailureCategoryId?: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export const OPAQUE_DISPATCH_REQUIRED_KEYS = [
  'contractVersion',
  'dispatchId',
  'tenantRouteId',
  'executionId',
  'definitionId',
  'definitionVersion',
  'stepId',
  'tenantExecutionStateRefId',
  'expectedRevision',
  'tenantEpoch',
  'workClassId',
  'priorityClassId',
  'deliveryState',
  'attempt',
  'notBefore',
  'correlationId',
  'createdAt',
  'updatedAt',
] as const;

export const OPAQUE_DISPATCH_OPTIONAL_KEYS = [
  'leaseRefId',
  'leaseExpiresAt',
  'privacySafeFailureCategoryId',
] as const;

export const OPAQUE_DISPATCH_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...OPAQUE_DISPATCH_REQUIRED_KEYS,
  ...OPAQUE_DISPATCH_OPTIONAL_KEYS,
]);

/** Names that must never appear on a spine row (privacy by construction). */
export const OPAQUE_DISPATCH_FORBIDDEN_KEYS = [
  'payload',
  'input',
  'output',
  'state',
  'sharedState',
  'stepHistory',
  'auth',
  'authSnapshot',
  'authSnapshotJson',
  'privateInput',
  'privateOutput',
  'error',
  'lastError',
  'prompt',
  'evidence',
] as const;

export const DEFAULT_WORK_CLASS_ID = 'plumbus.work.flow-step';
export const DEFAULT_PRIORITY_CLASS_ID = 'plumbus.priority.normal';

export type CasResult = 'ok' | 'stale' | 'missing';

export class RevisionConflictError extends Error {
  readonly code = 'revision-conflict';
  constructor(
    readonly executionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number | undefined,
  ) {
    super(
      `execution ${executionId}: expected revision ${expectedRevision}, found ${actualRevision ?? 'missing'}`,
    );
    this.name = 'RevisionConflictError';
  }
}

export class EpochMismatchError extends Error {
  readonly code = 'epoch-mismatch';
  constructor(
    readonly executionId: string,
    readonly spineEpoch: number,
    readonly tenantEpoch: number,
  ) {
    super(`execution ${executionId}: spine tenantEpoch ${spineEpoch} !== tenant ${tenantEpoch}`);
    this.name = 'EpochMismatchError';
  }
}
