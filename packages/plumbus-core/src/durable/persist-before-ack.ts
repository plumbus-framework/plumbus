// Persist-before-ack: every state transition CAS-updates tenant execution
// state and writes a dispatch-outbox row in the same transaction. The caller
// must not acknowledge inbound work until this function returns (the tenant
// commit has already happened). Publication to the spine is post-commit.

import { randomUUID } from 'node:crypto';
import type { TenantTx } from './memory-store.js';
import {
  DEFAULT_PRIORITY_CLASS_ID,
  DEFAULT_WORK_CLASS_ID,
  DurableExecutionStatus,
  DurableStepStatus,
  RevisionConflictError,
  type DispatchOutboxRow,
  type TenantExecutionState,
} from './types.js';

export interface AcceptInput {
  executionId: string;
  tenantRef: string;
  definitionId: string;
  definitionVersion: string;
  firstStepId: string;
  correlationId: string;
  idempotencyKey: string;
  workClassId?: string;
  priorityClassId?: string;
}

export interface PersistAcceptanceResult {
  kind: 'accepted' | 'duplicate';
  execution: TenantExecutionState;
  outbox?: DispatchOutboxRow;
}

export function persistAcceptance(
  tx: TenantTx,
  input: AcceptInput,
  nowIso: string,
): PersistAcceptanceResult {
  if (tx.hasIdempotency(input.idempotencyKey)) {
    const existing = tx.getExecution(input.executionId);
    if (!existing) {
      throw new Error(`idempotency key ${input.idempotencyKey} has no execution`);
    }
    return { kind: 'duplicate', execution: existing };
  }

  const stateRefId = `state:${input.executionId}`;
  const execution: TenantExecutionState = {
    executionId: input.executionId,
    stateRefId,
    tenantRef: input.tenantRef,
    revision: 1,
    tenantEpoch: tx.epoch,
    status: DurableExecutionStatus.Created,
    definitionId: input.definitionId,
    definitionVersion: input.definitionVersion,
    currentStepId: input.firstStepId,
    stepIndex: 0,
    attempt: 0,
    correlationId: input.correlationId,
    createdAt: nowIso,
    updatedAt: nowIso,
    terminal: false,
  };
  const outbox = newOutbox(tx, execution, input.firstStepId, nowIso, input);
  tx.insertExecution(execution);
  tx.insertOutbox(outbox);
  tx.putIdempotency(input.idempotencyKey);
  return { kind: 'accepted', execution, outbox };
}

export interface StepCompletionInput {
  executionId: string;
  expectedRevision: number;
  tenantEpoch: number;
  stepId: string;
  nextStepId?: string;
  sideEffectKey: string;
  sideEffectLabel: string;
}

export type PersistStepResult =
  | { kind: 'committed'; execution: TenantExecutionState; outbox?: DispatchOutboxRow; sideEffectApplied: boolean }
  | { kind: 'stale'; execution?: TenantExecutionState }
  | { kind: 'missing' }
  | { kind: 'epoch-mismatch' };

export function persistStepCompletion(
  tx: TenantTx,
  input: StepCompletionInput,
  nowIso: string,
): PersistStepResult {
  const current = tx.getExecution(input.executionId);
  if (!current) return { kind: 'missing' };
  if (current.tenantEpoch !== input.tenantEpoch) return { kind: 'epoch-mismatch' };
  if (current.revision !== input.expectedRevision) {
    return { kind: 'stale', execution: current };
  }
  if (current.terminal) return { kind: 'stale', execution: current };

  const applied = tx.applySideEffect(input.sideEffectKey, input.sideEffectLabel);
  const terminal = input.nextStepId === undefined;
  const next: TenantExecutionState = {
    ...current,
    revision: input.expectedRevision + 1,
    status: terminal ? DurableExecutionStatus.Succeeded : DurableExecutionStatus.Running,
    currentStepId: input.nextStepId ?? current.currentStepId,
    stepIndex: current.stepIndex + 1,
    attempt: 0,
    terminal,
    wakeAt: undefined,
    updatedAt: nowIso,
  };
  const cas = tx.casExecution(input.executionId, input.expectedRevision, next);
  if (cas !== 'ok') {
    return cas === 'missing' ? { kind: 'missing' } : { kind: 'stale', execution: current };
  }

  tx.putStep({
    stepExecutionId: `${input.executionId}:${input.stepId}:${current.attempt}`,
    executionId: input.executionId,
    stepId: input.stepId,
    attempt: current.attempt,
    state: DurableStepStatus.Succeeded,
    startedAt: nowIso,
    updatedAt: nowIso,
    completedAt: nowIso,
  });

  if (terminal) {
    tx.putTerminal({
      terminalStateId: `term:${input.executionId}`,
      executionId: input.executionId,
      operationalState: 'succeeded',
      finalRevision: next.revision,
      completedAt: nowIso,
    });
    return { kind: 'committed', execution: next, sideEffectApplied: applied };
  }

  const outbox = newOutbox(tx, next, input.nextStepId!, nowIso);
  tx.insertOutbox(outbox);
  return { kind: 'committed', execution: next, outbox, sideEffectApplied: applied };
}

export interface RetryScheduleInput {
  executionId: string;
  expectedRevision: number;
  tenantEpoch: number;
  stepId: string;
  notBefore: string;
}

export function persistRetrySchedule(
  tx: TenantTx,
  input: RetryScheduleInput,
  nowIso: string,
): PersistStepResult {
  const current = tx.getExecution(input.executionId);
  if (!current) return { kind: 'missing' };
  if (current.tenantEpoch !== input.tenantEpoch) return { kind: 'epoch-mismatch' };
  if (current.revision !== input.expectedRevision) {
    return { kind: 'stale', execution: current };
  }

  const next: TenantExecutionState = {
    ...current,
    revision: input.expectedRevision + 1,
    status: DurableExecutionStatus.RetryScheduled,
    currentStepId: input.stepId,
    attempt: current.attempt + 1,
    wakeAt: input.notBefore,
    updatedAt: nowIso,
    terminal: false,
  };
  const cas = tx.casExecution(input.executionId, input.expectedRevision, next);
  if (cas !== 'ok') {
    return cas === 'missing' ? { kind: 'missing' } : { kind: 'stale', execution: current };
  }

  tx.putWait({
    waitStateId: `wait:${input.executionId}:${next.revision}`,
    executionId: input.executionId,
    stepId: input.stepId,
    kind: 'retry',
    state: 'waiting',
    createdAt: nowIso,
    updatedAt: nowIso,
    notBefore: input.notBefore,
  });

  const outbox = newOutbox(tx, next, input.stepId, nowIso, { notBefore: input.notBefore });
  tx.insertOutbox(outbox);
  return { kind: 'committed', execution: next, outbox, sideEffectApplied: false };
}

export function assertCasCommitted(result: PersistStepResult, executionId: string, expectedRevision: number): void {
  if (result.kind === 'stale') {
    throw new RevisionConflictError(executionId, expectedRevision, result.execution?.revision);
  }
}

function newOutbox(
  tx: TenantTx,
  execution: TenantExecutionState,
  stepId: string,
  nowIso: string,
  extra?: Pick<AcceptInput, 'workClassId' | 'priorityClassId'> & { notBefore?: string },
): DispatchOutboxRow {
  return {
    outboxId: `outbox:${execution.executionId}:${execution.revision}:${randomUUID()}`,
    executionId: execution.executionId,
    stateRefId: execution.stateRefId,
    expectedRevision: execution.revision,
    tenantEpoch: tx.epoch,
    tenantRef: execution.tenantRef,
    stepId,
    definitionId: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    correlationId: execution.correlationId,
    workClassId: extra?.workClassId ?? DEFAULT_WORK_CLASS_ID,
    priorityClassId: extra?.priorityClassId ?? DEFAULT_PRIORITY_CLASS_ID,
    notBefore: extra?.notBefore ?? nowIso,
    createdAt: nowIso,
    superseded: false,
  };
}
