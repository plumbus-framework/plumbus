import { afterAll, describe, expect, it } from 'vitest';
import { extraHarnessConnection, createDurableTestHarness, type DurableTestHarness } from '../harness.js';
import { ackSpineDispatch, claimSpineDispatch, upsertSpineDispatch } from '../spine-claim.js';
import { createOpaqueDispatchRecord } from '../opaque-dispatch.js';
import { SpineDeliveryState } from '../types.js';

function hint(overrides: Partial<Parameters<typeof createOpaqueDispatchRecord>[0]> = {}) {
  return createOpaqueDispatchRecord({
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
    notBefore: '2020-01-01T00:00:00.000Z',
    correlationId: 'corr-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('spine SKIP LOCKED claim on real Postgres', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('gives each concurrent worker a different row and skips an unexpired lease', async () => {
    harness = await createDurableTestHarness();
    await upsertSpineDispatch(
      harness.spineDb,
      hint({ dispatchId: 'disp-a', executionId: 'exec-a', expectedRevision: 1 }),
    );
    await upsertSpineDispatch(
      harness.spineDb,
      hint({
        dispatchId: 'disp-b',
        executionId: 'exec-b',
        expectedRevision: 1,
        tenantExecutionStateRefId: 'state:exec-b',
      }),
    );

    const second = await extraHarnessConnection(harness.admin, harness.spineName);
    try {
      const [a, b] = await Promise.all([
        claimSpineDispatch(harness.spineDb, {
          workerId: 'worker-a',
          leaseDurationMs: 60_000,
          limit: 1,
        }),
        claimSpineDispatch(second.db, { workerId: 'worker-b', leaseDurationMs: 60_000, limit: 1 }),
      ]);
      const claimed = [...a, ...b].map((row) => row.executionId).sort();
      expect(claimed).toEqual(['exec-a', 'exec-b']);
      expect(a[0]?.deliveryState).toBe(SpineDeliveryState.Leased);
      expect(b[0]?.deliveryState).toBe(SpineDeliveryState.Leased);

      const empty = await claimSpineDispatch(harness.spineDb, {
        workerId: 'worker-c',
        leaseDurationMs: 60_000,
        limit: 5,
      });
      expect(empty).toEqual([]);

      expect(await ackSpineDispatch(harness.spineDb, a[0]!.dispatchId)).toBe(true);
    } finally {
      await second.close();
    }
  });
});
