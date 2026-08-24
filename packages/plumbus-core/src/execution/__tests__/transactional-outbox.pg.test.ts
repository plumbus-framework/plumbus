import { afterAll, describe, expect, it } from 'vitest';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';
import { listUnpublishedOutbox, loadExecutionState } from '../../durable/postgres-persist.js';
import { createTransactionRunner } from '../transactional-outbox.js';

describe('createTransactionRunner persist-before-ack on Postgres', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('writes dispatch_outbox in the same tenant txn and rolls it back on throw', async () => {
    harness = await createDurableTestHarness();
    const runner = createTransactionRunner({
      db: harness.tenantDb,
      entities: { createDataService: () => ({}) } as never,
      events: { get: () => undefined } as never,
      getAuth: () => ({ userId: 'u1', roles: [], scopes: [], provider: 'test' }),
      getAudit: () => ({ record: async () => undefined }) as never,
      durableDispatch: { schemaName: harness.coreSchema },
    });

    await expect(
      runner(async (scope) => {
        await scope.persistAcceptance?.({
          executionId: 'exec-rollback',
          tenantRef: 'tenant-a',
          definitionId: 'flow:demo',
          definitionVersion: '1.0.0',
          firstStepId: 'step-a',
          correlationId: 'corr-rollback',
        });
        throw new Error('rollback me');
      }),
    ).rejects.toThrow('rollback me');

    expect(
      await loadExecutionState(harness.tenantDb, 'exec-rollback', harness.coreSchema),
    ).toBeUndefined();
    expect(await listUnpublishedOutbox(harness.tenantDb, harness.coreSchema)).toEqual([]);

    const committed = await runner(async (scope) => {
      return scope.persistAcceptance?.({
        executionId: 'exec-commit',
        tenantRef: 'tenant-a',
        definitionId: 'flow:demo',
        definitionVersion: '1.0.0',
        firstStepId: 'step-a',
        correlationId: 'corr-commit',
      });
    });
    expect(committed?.outboxId).toBeTruthy();
    expect(
      await loadExecutionState(harness.tenantDb, 'exec-commit', harness.coreSchema),
    ).toMatchObject({
      executionId: 'exec-commit',
      revision: 1,
    });
    const unpublished = await listUnpublishedOutbox(harness.tenantDb, harness.coreSchema);
    expect(unpublished).toHaveLength(1);
    expect(unpublished[0]?.executionId).toBe('exec-commit');
  });
});
