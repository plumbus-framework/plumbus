import { describe, expect, it } from 'vitest';
import { createMemoryTenantStore } from '../memory-store.js';
import { persistAcceptance, persistStepCompletion } from '../persist-before-ack.js';

function now(): string {
  return '2026-08-20T00:00:00.000Z';
}

const acceptInput = {
  executionId: 'exec-1',
  tenantRef: 'tenant-a',
  definitionId: 'flow:demo',
  definitionVersion: '1.0.0',
  firstStepId: 'step-a',
  correlationId: 'corr-1',
  idempotencyKey: 'accept:exec-1',
} as const;

describe('persist-before-ack', () => {
  it('does not ack until the tenant transaction commits', () => {
    const store = createMemoryTenantStore();
    let acked = false;
    try {
      store.runInTransaction((tx) => {
        persistAcceptance(tx, acceptInput, now());
        throw new Error('crash inside tenant transaction');
      });
      acked = true;
    } catch (error) {
      expect((error as Error).message).toBe('crash inside tenant transaction');
    }
    expect(acked).toBe(false);
    expect(store.getExecution('exec-1')).toBeUndefined();
    expect(store.listOutbox()).toEqual([]);
    expect(store.listSideEffects()).toEqual([]);
  });

  it('writes execution state and dispatch-outbox in the same commit', () => {
    const store = createMemoryTenantStore();
    const result = store.runInTransaction((tx) => persistAcceptance(tx, acceptInput, now()));
    expect(result.kind).toBe('accepted');
    expect(result.outbox?.expectedRevision).toBe(1);
    expect(store.getExecution('exec-1')?.revision).toBe(1);
    expect(store.listOutbox()).toHaveLength(1);
    expect(store.listOutbox()[0]?.publishedAt).toBeUndefined();
  });

  it('rolls back both the state transition and the outbox row together', () => {
    const store = createMemoryTenantStore();
    store.runInTransaction((tx) => persistAcceptance(tx, acceptInput, now()));
    try {
      store.runInTransaction((tx) => {
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
        );
        throw new Error('crash after writes before commit');
      });
    } catch {
      // expected
    }
    expect(store.getExecution('exec-1')?.revision).toBe(1);
    expect(store.listOutbox()).toHaveLength(1);
    expect(store.listSideEffects()).toEqual([]);
  });

  it('treats a retried accept as a duplicate after a durable commit', () => {
    const store = createMemoryTenantStore();
    store.runInTransaction((tx) => persistAcceptance(tx, acceptInput, now()));
    const retry = store.runInTransaction((tx) => persistAcceptance(tx, acceptInput, now()));
    expect(retry.kind).toBe('duplicate');
    expect(retry.outbox).toBeUndefined();
    expect(store.listOutbox()).toHaveLength(1);
  });
});
