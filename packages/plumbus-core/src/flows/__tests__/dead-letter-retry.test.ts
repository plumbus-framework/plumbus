import { describe, expect, it } from 'vitest';
import { deadLetterFlow, retryDeadLetteredFlow } from '../dead-letter.js';
import { flowDeadLetterTable, flowExecutionsTable } from '../schema.js';
import { FlowStatus } from '../state-machine.js';

function mockRecoveryDb() {
  const executions = new Map<string, Record<string, unknown>>();
  const deadLetters = new Map<string, Record<string, unknown>>();

  function storeFor(table: unknown) {
    return table === flowDeadLetterTable ? deadLetters : executions;
  }

  return {
    _executions: executions,
    _deadLetters: deadLetters,
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                async limit(n: number) {
                  return [...storeFor(table).values()].slice(0, n);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          const store = storeFor(table);
          const key = String(row.executionId ?? row.id);
          store.set(key, { ...row, failedAt: new Date() });
          return {
            onConflictDoNothing() {
              return Promise.resolve();
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              for (const row of storeFor(table).values()) {
                Object.assign(row, values);
              }
              return Promise.resolve({ rowCount: storeFor(table).size });
            },
          };
        },
      };
    },
  } as never;
}

describe('retryDeadLetteredFlow', () => {
  it('requires an actor', async () => {
    const db = mockRecoveryDb();
    await expect(retryDeadLetteredFlow(db, 'missing', { actor: '' })).rejects.toThrow(
      'requires an actor',
    );
  });

  it('resets a failed execution and records the operator', async () => {
    const db = mockRecoveryDb();
    db._executions.set('exec-1', {
      id: 'exec-1',
      flowName: 'orders.fail',
      status: FlowStatus.Failed,
      input: { orderId: '1' },
      state: { step: 1 },
      stepHistory: [{ step: 'charge', status: 'failed' }],
      lastError: 'step failed',
      retryCount: 2,
      actor: 'user-1',
      tenantId: 't1',
      correlationId: 'c1',
      triggerEventId: null,
      createdAt: new Date(),
      completedAt: new Date(),
    });

    await deadLetterFlow(db, 'exec-1');
    expect(db._deadLetters.size).toBe(1);

    const result = await retryDeadLetteredFlow(db, 'exec-1', {
      actor: 'ops-ada',
      reason: 'operator-retry',
    });
    expect(result.retriedBy).toBe('ops-ada');

    const execution = db._executions.get('exec-1');
    expect(execution?.status).toBe(FlowStatus.Created);
    expect(execution?.retryCount).toBe(0);
    expect(execution?.lastError).toBeNull();
    expect(execution?.state).toMatchObject({
      step: 1,
      __operatorRetry: { retriedBy: 'ops-ada', reason: 'operator-retry' },
    });

    const dlq = [...db._deadLetters.values()][0];
    expect(dlq?.metadata).toMatchObject({ retriedBy: 'ops-ada', reason: 'operator-retry' });
  });

  it('refuses a second operator retry on the same dead-letter row', async () => {
    const db = mockRecoveryDb();
    db._executions.set('exec-2', {
      id: 'exec-2',
      flowName: 'orders.fail',
      status: FlowStatus.Failed,
      input: {},
      state: null,
      stepHistory: [],
      lastError: 'fail',
      retryCount: 1,
      actor: 'user-1',
      createdAt: new Date(),
    });
    await deadLetterFlow(db, 'exec-2');
    await retryDeadLetteredFlow(db, 'exec-2', { actor: 'ops-ada' });
    await expect(retryDeadLetteredFlow(db, 'exec-2', { actor: 'ops-ada' })).rejects.toThrow(
      'already retried',
    );
  });
});

describe('deadLetterFlow', () => {
  it('refuses non-failed executions', async () => {
    const db = mockRecoveryDb();
    db._executions.set('exec-ok', {
      id: 'exec-ok',
      status: FlowStatus.Completed,
    });
    await expect(deadLetterFlow(db, 'exec-ok')).rejects.toThrow('expected "failed"');
  });
});
