import { describe, expect, it } from 'vitest';
import { PlumbusError } from '../../errors/plumbus-error.js';
import {
  assertOpaqueDispatch,
  createOpaqueDispatchRecord,
  spineRecordFromUnknown,
} from '../opaque-dispatch.js';
import { OPAQUE_DISPATCH_FORBIDDEN_KEYS, SpineDeliveryState } from '../types.js';

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '0.1.0',
    dispatchId: 'disp-1',
    tenantRouteId: 'tenant-a',
    executionId: 'exec-1',
    definitionId: 'flow:demo',
    definitionVersion: '1.0.0',
    stepId: 'step-a',
    tenantExecutionStateRefId: 'state:exec-1',
    expectedRevision: 1,
    tenantEpoch: 1,
    workClassId: 'plumbus.work.flow-step',
    priorityClassId: 'plumbus.priority.normal',
    deliveryState: SpineDeliveryState.Ready,
    attempt: 0,
    notBefore: '2026-08-20T00:00:00.000Z',
    correlationId: 'corr-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('opaque dispatch privacy', () => {
  it('accepts a scheduling-only record', () => {
    const record = createOpaqueDispatchRecord(validRecord());
    expect(record.executionId).toBe('exec-1');
    expect(record.expectedRevision).toBe(1);
    expect(record).not.toHaveProperty('payload');
  });

  it.each([...OPAQUE_DISPATCH_FORBIDDEN_KEYS])('rejects private field %s', (key) => {
    expect(() => spineRecordFromUnknown(validRecord({ [key]: 'secret' }))).toThrow(PlumbusError);
  });

  it('rejects additional properties', () => {
    expect(() => spineRecordFromUnknown(validRecord({ stepInput: { n: 1 } }))).toThrow(/additional property/);
  });

  it('requires lease fields when deliveryState is leased', () => {
    expect(() =>
      spineRecordFromUnknown(validRecord({ deliveryState: SpineDeliveryState.Leased })),
    ).toThrow(/leaseRefId/);
    expect(() =>
      assertOpaqueDispatch(
        validRecord({
          deliveryState: SpineDeliveryState.Leased,
          leaseRefId: 'worker-1',
          leaseExpiresAt: '2026-08-20T00:01:00.000Z',
        }),
      ),
    ).not.toThrow();
  });
});
