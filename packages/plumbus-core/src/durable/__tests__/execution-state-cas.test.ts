import { describe, expect, it } from 'vitest';
import { createMemoryTenantStore } from '../memory-store.js';
import { persistAcceptance, persistStepCompletion } from '../persist-before-ack.js';
import { DurableExecutionStatus, RevisionConflictError } from '../types.js';

function now(): string {
  return '2026-08-20T00:00:00.000Z';
}

describe('revision CAS', () => {
  it('rejects a stale write and leaves the row unchanged', () => {
    const store = createMemoryTenantStore();
    store.runInTransaction((tx) => {
      persistAcceptance(
        tx,
        {
          executionId: 'exec-1',
          tenantRef: 'tenant-a',
          definitionId: 'flow:demo',
          definitionVersion: '1.0.0',
          firstStepId: 'step-a',
          correlationId: 'corr-1',
          idempotencyKey: 'accept:exec-1',
        },
        now(),
      );
    });

    const first = store.getExecution('exec-1');
    expect(first?.revision).toBe(1);

    const stale = store.runInTransaction((tx) =>
      persistStepCompletion(
        tx,
        {
          executionId: 'exec-1',
          expectedRevision: 0,
          tenantEpoch: 1,
          stepId: 'step-a',
          nextStepId: 'step-b',
          sideEffectKey: 'stale',
          sideEffectLabel: 'stale-effect',
        },
        now(),
      ),
    );
    expect(stale.kind).toBe('stale');
    expect(store.getExecution('exec-1')?.revision).toBe(1);
    expect(store.listSideEffects()).toEqual([]);
  });

  it('throws RevisionConflictError when the caller asserts a stale CAS', () => {
    const error = new RevisionConflictError('exec-1', 2, 1);
    expect(error.code).toBe('revision-conflict');
    expect(error.message).toContain('expected revision 2');
  });

  it('commits a matching revision and refuses a second writer at the same revision', () => {
    const store = createMemoryTenantStore();
    store.runInTransaction((tx) => {
      persistAcceptance(
        tx,
        {
          executionId: 'exec-1',
          tenantRef: 'tenant-a',
          definitionId: 'flow:demo',
          definitionVersion: '1.0.0',
          firstStepId: 'step-a',
          correlationId: 'corr-1',
          idempotencyKey: 'accept:exec-1',
        },
        now(),
      );
    });

    const won = store.runInTransaction((tx) =>
      persistStepCompletion(
        tx,
        {
          executionId: 'exec-1',
          expectedRevision: 1,
          tenantEpoch: 1,
          stepId: 'step-a',
          nextStepId: 'step-b',
          sideEffectKey: 'exec-1:step-a:0',
          sideEffectLabel: 'exec-1:step-a',
        },
        now(),
      ),
    );
    expect(won.kind).toBe('committed');
    expect(store.getExecution('exec-1')?.revision).toBe(2);
    expect(store.getExecution('exec-1')?.status).toBe(DurableExecutionStatus.Running);

    const lost = store.runInTransaction((tx) =>
      persistStepCompletion(
        tx,
        {
          executionId: 'exec-1',
          expectedRevision: 1,
          tenantEpoch: 1,
          stepId: 'step-a',
          nextStepId: 'step-b',
          sideEffectKey: 'exec-1:step-a:dup',
          sideEffectLabel: 'dup-effect',
        },
        now(),
      ),
    );
    expect(lost.kind).toBe('stale');
    expect(store.listSideEffects()).toEqual(['exec-1:step-a']);
  });
});
