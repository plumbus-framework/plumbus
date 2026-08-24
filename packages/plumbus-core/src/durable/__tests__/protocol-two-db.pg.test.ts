import { afterAll, describe, expect, it } from 'vitest';
import { createDurableTestHarness, type DurableTestHarness } from '../harness.js';
import {
  bumpTenantEpochOnDb,
  casAdvanceExecution,
  listSideEffects,
  listUnpublishedOutbox,
  loadExecutionState,
  persistAcceptanceOnDb,
  publishOutboxToSpine,
} from '../postgres-persist.js';
import { ackSpineDispatch, claimSpineDispatch } from '../spine-claim.js';

describe('Protocol A on two real databases', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('persists before publish, claims on the spine, and no-ops after epoch restore', async () => {
    harness = await createDurableTestHarness();
    const nowIso = new Date().toISOString();
    const accepted = await persistAcceptanceOnDb(
      harness.tenantDb,
      {
        executionId: 'exec-1',
        tenantRef: 'tenant-a',
        definitionId: 'flow:demo',
        definitionVersion: '1.0.0',
        firstStepId: 'step-a',
        correlationId: 'corr-1',
        nowIso,
      },
      harness.coreSchema,
    );
    expect(accepted.execution.revision).toBe(1);
    expect(accepted.outbox.publishedAt).toBeUndefined();

    const unpublished = await listUnpublishedOutbox(harness.tenantDb, harness.coreSchema);
    expect(unpublished).toHaveLength(1);

    const published = await publishOutboxToSpine(
      harness.tenantDb,
      harness.spineDb,
      accepted.outbox,
      'disp:exec-1:1',
      nowIso,
      harness.coreSchema,
    );
    expect(published.expectedRevision).toBe(1);
    expect(published).not.toHaveProperty('payload');

    const claimed = await claimSpineDispatch(harness.spineDb, {
      workerId: 'worker-1',
      leaseDurationMs: 30_000,
      limit: 1,
    });
    expect(claimed).toHaveLength(1);
    const tenant = await loadExecutionState(harness.tenantDb, 'exec-1', harness.coreSchema);
    expect(tenant?.revision).toBe(claimed[0]?.expectedRevision);

    const cas = await casAdvanceExecution(
      harness.tenantDb,
      {
        executionId: 'exec-1',
        expectedRevision: 1,
        nextStatus: 'running',
        nextStepId: 'step-b',
        terminal: false,
        nowIso,
        sideEffectKey: 'exec-1:step-a:1',
        sideEffectLabel: 'exec-1:step-a',
      },
      harness.coreSchema,
    );
    expect(cas).toBe('ok');
    expect(
      await casAdvanceExecution(
        harness.tenantDb,
        {
          executionId: 'exec-1',
          expectedRevision: 1,
          nextStatus: 'running',
          nextStepId: 'step-b',
          terminal: false,
          nowIso,
          sideEffectKey: 'exec-1:step-a:dup',
          sideEffectLabel: 'dup',
        },
        harness.coreSchema,
      ),
    ).toBe('stale');
    expect(await listSideEffects(harness.tenantDb, harness.coreSchema)).toEqual(['exec-1:step-a']);

    await ackSpineDispatch(harness.spineDb, claimed[0]!.dispatchId);

    const epoch = await bumpTenantEpochOnDb(harness.tenantDb, harness.coreSchema);
    expect(epoch).toBeGreaterThanOrEqual(2);
    const restored = await loadExecutionState(harness.tenantDb, 'exec-1', harness.coreSchema);
    expect(restored?.tenantEpoch).toBe(epoch);

    await publishOutboxToSpine(
      harness.tenantDb,
      harness.spineDb,
      {
        ...accepted.outbox,
        tenantEpoch: epoch,
        publishedAt: undefined,
        expectedRevision: 1,
      },
      'disp:exec-1:stale',
      nowIso,
      harness.coreSchema,
    );
    const staleClaim = await claimSpineDispatch(harness.spineDb, {
      workerId: 'worker-2',
      leaseDurationMs: 30_000,
      limit: 5,
    });
    const live = await loadExecutionState(harness.tenantDb, 'exec-1', harness.coreSchema);
    for (const row of staleClaim) {
      if (!live || live.tenantEpoch !== row.tenantEpoch || live.revision !== row.expectedRevision) {
        await ackSpineDispatch(harness.spineDb, row.dispatchId);
      }
    }
    expect(await listSideEffects(harness.tenantDb, harness.coreSchema)).toEqual(['exec-1:step-a']);
  });
});
