import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createOpaqueDispatchRecord } from '../opaque-dispatch.js';
import {
  bumpTenantEpochOnDb,
  casAdvanceExecution,
  listSideEffects,
  listUnpublishedOutbox,
  loadExecutionState,
  markOutboxAcked,
  persistAcceptanceOnDb,
  publishOutboxToSpine,
} from '../postgres-persist.js';
import { ackSpineDispatch, claimSpineDispatch, upsertSpineDispatch } from '../spine-claim.js';
import { DEFAULT_PRIORITY_CLASS_ID, DEFAULT_WORK_CLASS_ID, SpineDeliveryState } from '../types.js';
import { createDurableTestHarness, type DurableTestHarness } from '../harness.js';

/**
 * E3.5 chaos on two local Postgres DBs. Every persist checkpoint is exercised
 * as a SQL crash window (commit / skip the next write). Extra process-SIGKILL
 * at those later windows is implemented in sigkill-chaos.pg.test.ts for the
 * pre-commit path only — further kill cycles on a shared host Postgres are
 * skipped here (leftover backends can block DROP DATABASE).
 */
describe('E3.5 Protocol A chaos on two databases', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  async function accept(executionId: string) {
    return persistAcceptanceOnDb(
      harness.tenantDb,
      {
        executionId,
        tenantRef: 'tenant-a',
        definitionId: 'flow:demo',
        definitionVersion: '1.0.0',
        firstStepId: 'step-a',
        correlationId: `corr-${executionId}`,
        nowIso: new Date().toISOString(),
      },
      harness.coreSchema,
    );
  }

  it('covers persist checkpoints, duplicate/delayed dispatch, and restore-as-chaos', async () => {
    harness = await createDurableTestHarness();
    const schema = harness.coreSchema;
    const nowIso = new Date().toISOString();

    // after-tenant-commit-before-publish: committed outbox, no spine row yet.
    const gap = await accept('exec-publish-gap');
    expect(gap.outbox.publishedAt).toBeUndefined();
    expect(await listUnpublishedOutbox(harness.tenantDb, schema)).toEqual(
      expect.arrayContaining([expect.objectContaining({ executionId: 'exec-publish-gap' })]),
    );
    await publishOutboxToSpine(
      harness.tenantDb,
      harness.spineDb,
      gap.outbox,
      'disp:exec-publish-gap:1',
      nowIso,
      schema,
    );

    // after-spine-upsert-before-outbox-mark: spine hint exists, tenant still unpublished.
    const markGap = await accept('exec-mark-gap');
    await upsertSpineDispatch(
      harness.spineDb,
      createOpaqueDispatchRecord({
        dispatchId: 'disp:exec-mark-gap:orphan',
        tenantRouteId: 'tenant-a',
        executionId: 'exec-mark-gap',
        definitionId: 'flow:demo',
        definitionVersion: '1.0.0',
        stepId: 'step-a',
        tenantExecutionStateRefId: markGap.execution.stateRefId,
        expectedRevision: 1,
        tenantEpoch: 1,
        workClassId: DEFAULT_WORK_CLASS_ID,
        priorityClassId: DEFAULT_PRIORITY_CLASS_ID,
        deliveryState: SpineDeliveryState.Ready,
        attempt: 0,
        notBefore: nowIso,
        correlationId: 'corr-exec-mark-gap',
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    );
    expect(
      (await listUnpublishedOutbox(harness.tenantDb, schema)).some(
        (row) => row.executionId === 'exec-mark-gap' && !row.publishedAt,
      ),
    ).toBe(true);
    await publishOutboxToSpine(
      harness.tenantDb,
      harness.spineDb,
      markGap.outbox,
      'disp:exec-mark-gap:1',
      nowIso,
      schema,
    );

    // after-claim-before-tenant-reread: lease held, second claim skips; expire and reclaim.
    const claimed = await accept('exec-claim');
    await publishOutboxToSpine(
      harness.tenantDb,
      harness.spineDb,
      claimed.outbox,
      'disp:exec-claim:1',
      nowIso,
      schema,
    );
    const firstClaim = await claimSpineDispatch(harness.spineDb, {
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
      limit: 10,
    });
    expect(firstClaim.some((row) => row.executionId === 'exec-claim')).toBe(true);
    const skipped = await claimSpineDispatch(harness.spineDb, {
      workerId: 'worker-2',
      leaseDurationMs: 60_000,
      limit: 10,
    });
    expect(skipped.some((row) => row.executionId === 'exec-claim')).toBe(false);
    await harness.spineDb.execute(sql`
      UPDATE opaque_dispatch
      SET lease_expires_at = now() - interval '1 second'
      WHERE execution_id = 'exec-claim'
    `);
    const reclaimed = await claimSpineDispatch(harness.spineDb, {
      workerId: 'worker-2',
      leaseDurationMs: 30_000,
      limit: 10,
    });
    const claimRow = reclaimed.find((row) => row.executionId === 'exec-claim');
    expect(claimRow).toBeDefined();
    const live = await loadExecutionState(harness.tenantDb, 'exec-claim', schema);
    expect(live?.revision).toBe(claimRow?.expectedRevision);

    // after-tenant-commit-before-spine-ack: CAS committed, spine still leased.
    const cas = await casAdvanceExecution(
      harness.tenantDb,
      {
        executionId: 'exec-claim',
        expectedRevision: 1,
        nextStatus: 'running',
        nextStepId: 'step-b',
        terminal: false,
        nowIso,
        sideEffectKey: 'exec-claim:step-a:1',
        sideEffectLabel: 'exec-claim:step-a',
      },
      schema,
    );
    expect(cas).toBe('ok');
    await ackSpineDispatch(harness.spineDb, claimRow!.dispatchId);
    await markOutboxAcked(harness.tenantDb, claimed.outbox.outboxId, nowIso, schema);

    // duplicate dispatch: republish same revision after ack; CAS is stale; one side effect.
    await publishOutboxToSpine(
      harness.tenantDb,
      harness.spineDb,
      { ...claimed.outbox, publishedAt: undefined, spineRowId: undefined },
      'disp:exec-claim:dup',
      nowIso,
      schema,
    );
    const dupClaim = await claimSpineDispatch(harness.spineDb, {
      workerId: 'worker-dup',
      leaseDurationMs: 30_000,
      limit: 10,
    });
    for (const row of dupClaim.filter((item) => item.executionId === 'exec-claim')) {
      const tenant = await loadExecutionState(harness.tenantDb, 'exec-claim', schema);
      if (!tenant || tenant.revision !== row.expectedRevision) {
        await ackSpineDispatch(harness.spineDb, row.dispatchId);
      }
    }
    expect(
      await casAdvanceExecution(
        harness.tenantDb,
        {
          executionId: 'exec-claim',
          expectedRevision: 1,
          nextStatus: 'running',
          nextStepId: 'step-b',
          terminal: false,
          nowIso,
          sideEffectKey: 'exec-claim:step-a:dup',
          sideEffectLabel: 'dup',
        },
        schema,
      ),
    ).toBe('stale');
    expect(await listSideEffects(harness.tenantDb, schema)).toEqual(
      expect.arrayContaining(['exec-claim:step-a']),
    );
    expect(await listSideEffects(harness.tenantDb, schema)).not.toContain('dup');

    // delayed dispatch: advance revision, then deliver an old spine hint.
    const delayed = await accept('exec-delay');
    await publishOutboxToSpine(
      harness.tenantDb,
      harness.spineDb,
      delayed.outbox,
      'disp:exec-delay:1',
      nowIso,
      schema,
    );
    expect(
      await casAdvanceExecution(
        harness.tenantDb,
        {
          executionId: 'exec-delay',
          expectedRevision: 1,
          nextStatus: 'running',
          nextStepId: 'step-b',
          terminal: false,
          nowIso,
          sideEffectKey: 'exec-delay:step-a:1',
          sideEffectLabel: 'exec-delay:step-a',
        },
        schema,
      ),
    ).toBe('ok');
    const late = await claimSpineDispatch(harness.spineDb, {
      workerId: 'worker-late',
      leaseDurationMs: 30_000,
      limit: 10,
    });
    for (const row of late.filter((item) => item.executionId === 'exec-delay')) {
      const tenant = await loadExecutionState(harness.tenantDb, 'exec-delay', schema);
      if (
        !tenant ||
        tenant.revision !== row.expectedRevision ||
        tenant.tenantEpoch !== row.tenantEpoch
      ) {
        await ackSpineDispatch(harness.spineDb, row.dispatchId);
      }
    }
    expect(await listSideEffects(harness.tenantDb, schema)).toEqual(
      expect.arrayContaining(['exec-delay:step-a']),
    );

    // restore-as-chaos: work commits, then epoch bump leaves a dangling spine hint.
    const restore = await accept('exec-restore');
    await publishOutboxToSpine(
      harness.tenantDb,
      harness.spineDb,
      restore.outbox,
      'disp:exec-restore:1',
      nowIso,
      schema,
    );
    expect(
      await casAdvanceExecution(
        harness.tenantDb,
        {
          executionId: 'exec-restore',
          expectedRevision: 1,
          nextStatus: 'running',
          nextStepId: 'step-b',
          terminal: false,
          nowIso,
          sideEffectKey: 'exec-restore:step-a:1',
          sideEffectLabel: 'exec-restore:step-a',
        },
        schema,
      ),
    ).toBe('ok');
    const epoch = await bumpTenantEpochOnDb(harness.tenantDb, schema);
    expect(epoch).toBeGreaterThanOrEqual(2);
    const afterRestore = await claimSpineDispatch(harness.spineDb, {
      workerId: 'worker-restore',
      leaseDurationMs: 30_000,
      limit: 20,
    });
    for (const row of afterRestore.filter((item) => item.executionId === 'exec-restore')) {
      const tenant = await loadExecutionState(harness.tenantDb, 'exec-restore', schema);
      if (
        !tenant ||
        tenant.tenantEpoch !== row.tenantEpoch ||
        tenant.revision !== row.expectedRevision
      ) {
        await ackSpineDispatch(harness.spineDb, row.dispatchId);
      }
    }
    expect(
      await casAdvanceExecution(
        harness.tenantDb,
        {
          executionId: 'exec-restore',
          expectedRevision: 1,
          nextStatus: 'running',
          nextStepId: 'step-b',
          terminal: false,
          nowIso,
          sideEffectKey: 'exec-restore:step-a:stale-epoch',
          sideEffectLabel: 'stale-epoch',
        },
        schema,
      ),
    ).toBe('stale');
    const restored = await loadExecutionState(harness.tenantDb, 'exec-restore', schema);
    expect(restored?.tenantEpoch).toBe(epoch);
    expect(await listSideEffects(harness.tenantDb, schema)).toEqual(
      expect.arrayContaining(['exec-restore:step-a']),
    );
    expect(await listSideEffects(harness.tenantDb, schema)).not.toContain('stale-epoch');
  }, 20_000);
});
