import { describe, expect, it } from 'vitest';
import {
  insertDispatchOutbox,
  listUnpublishedOutbox,
  loadExecutionState,
} from '../postgres-persist.js';

const instant = '2026-01-01T00:00:00.000Z';
const executionRow = {
  execution_id: 'synthetic-execution',
  state_ref_id: 'synthetic-state',
  tenant_ref: 'synthetic-tenant',
  revision: 1,
  tenant_epoch: 1,
  status: 'running',
  definition_id: 'synthetic-flow',
  definition_version: '1',
  current_step_id: 'step-a',
  step_index: 0,
  attempt: 0,
  correlation_id: 'synthetic-correlation',
  created_at: new Date(instant),
  updated_at: new Date(instant),
  wake_at: null,
  terminal: false,
};
function databaseReturning(rows: Record<string, unknown>[]) {
  return { execute: async () => rows } as unknown as Parameters<typeof loadExecutionState>[0];
}

describe('durable record mapping', () => {
  it('retains required timestamps and keeps nullable wake times absent', async () => {
    expect(
      await loadExecutionState(databaseReturning([executionRow]), 'synthetic-execution'),
    ).toMatchObject({
      createdAt: instant,
      updatedAt: instant,
      wakeAt: undefined,
    });
  });
  it.each(['created_at', 'updated_at'])('refuses a missing execution %s', async (field) => {
    await expect(
      loadExecutionState(
        databaseReturning([{ ...executionRow, [field]: null }]),
        'synthetic-execution',
      ),
    ).rejects.toMatchObject({ code: 'internal', metadata: { field } });
  });
  it.each(['not_before', 'created_at'])('refuses a missing outbox %s', async (field) => {
    const row = { not_before: instant, created_at: instant, [field]: null };
    await expect(listUnpublishedOutbox(databaseReturning([row]))).rejects.toMatchObject({
      code: 'internal',
      metadata: { field },
    });
  });
  it('refuses when an inserted outbox cannot be read back', async () => {
    const execution = await loadExecutionState(
      databaseReturning([executionRow]),
      'synthetic-execution',
    );
    if (!execution) throw new Error('fixture execution is missing');
    await expect(
      insertDispatchOutbox(databaseReturning([]), execution, 'step-b', instant),
    ).rejects.toMatchObject({
      code: 'internal',
      message: 'Inserted dispatch outbox row could not be read',
    });
  });
});
