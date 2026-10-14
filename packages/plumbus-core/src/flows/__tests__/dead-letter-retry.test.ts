import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { deadLetterFlow, retryDeadLetteredFlow } from '../dead-letter.js';
import { flowDeadLetterTable } from '../schema.js';
import { FlowStatus } from '../state-machine.js';

const dialect = new PgDialect();

/** Evaluates the `"column" = $n [and ...]` conditions these code paths use against a row. */
function matcher(condition: SQL | undefined): (row: Record<string, unknown>) => boolean {
  if (!condition) return () => true;
  const query = dialect.sqlToQuery(condition);
  const pairs = [...query.sql.matchAll(/"(\w+)" = \$(\d+)/g)].map(
    ([, column, index]) =>
      [
        (column ?? '').replace(/_(\w)/g, (_, char: string) => char.toUpperCase()),
        query.params[Number(index) - 1],
      ] as const,
  );
  return (row) => pairs.every(([key, value]) => row[key] === value);
}

function mockRecoveryDb() {
  const executions = new Map<string, Record<string, unknown>>();
  const deadLetters = new Map<string, Record<string, unknown>>();
  const locks: string[] = [];

  function storeFor(table: unknown) {
    return table === flowDeadLetterTable ? deadLetters : executions;
  }

  const db = {
    _executions: executions,
    _deadLetters: deadLetters,
    _locks: locks,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    },
    select() {
      return {
        from(table: unknown) {
          return {
            where(condition?: SQL) {
              const rows = () => [...storeFor(table).values()].filter(matcher(condition));
              return {
                async limit(n: number) {
                  return rows().slice(0, n);
                },
                async for(mode: string) {
                  locks.push(
                    `${table === flowDeadLetterTable ? 'dead-letter' : 'execution'}:${mode}`,
                  );
                  return rows();
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
            where(condition?: SQL) {
              const updated = [...storeFor(table).values()].filter(matcher(condition));
              for (const row of updated) Object.assign(row, values);
              const result = Promise.resolve({ rowCount: updated.length });
              return Object.assign(result, {
                async returning() {
                  return updated.map((row) => ({ id: row.id }));
                },
              });
            },
          };
        },
      };
    },
  };
  return db as never;
}

function failedExecution(id: string): Record<string, unknown> {
  return {
    id,
    flowName: 'orders.fail',
    status: FlowStatus.Failed,
    input: {},
    state: null,
    stepHistory: [],
    lastError: 'fail',
    retryCount: 1,
    actor: 'user-1',
    createdAt: new Date(),
  };
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

  it('checks the guards under the dead-letter row lock replay takes', async () => {
    const db = mockRecoveryDb();
    db._executions.set('exec-3', failedExecution('exec-3'));
    await deadLetterFlow(db, 'exec-3');
    await retryDeadLetteredFlow(db, 'exec-3', { actor: 'ops-ada' });
    expect(db._locks).toEqual(['dead-letter:update']);
  });

  it('refuses a dead letter that was already replayed and keeps the replay record', async () => {
    const db = mockRecoveryDb();
    db._executions.set('exec-4', failedExecution('exec-4'));
    await deadLetterFlow(db, 'exec-4');
    const dlq = db._deadLetters.get('exec-4');
    const replayed = { ...(dlq?.metadata as object), replayExecutionId: 'replay-1' };
    Object.assign(dlq ?? {}, { metadata: replayed });

    await expect(retryDeadLetteredFlow(db, 'exec-4', { actor: 'ops-ada' })).rejects.toThrow(
      'already replayed as "replay-1"',
    );
    expect(db._executions.get('exec-4')?.status).toBe(FlowStatus.Failed);
    expect(db._deadLetters.get('exec-4')?.metadata).toEqual(replayed);
  });

  it('does not reset an execution that is no longer failed', async () => {
    const db = mockRecoveryDb();
    db._executions.set('exec-5', failedExecution('exec-5'));
    await deadLetterFlow(db, 'exec-5');
    const before = { ...(db._deadLetters.get('exec-5')?.metadata as object) };
    // A worker (or another operator) already moved the row on.
    Object.assign(db._executions.get('exec-5') ?? {}, { status: FlowStatus.Running });

    await expect(retryDeadLetteredFlow(db, 'exec-5', { actor: 'ops-ada' })).rejects.toThrow(
      'is no longer failed (status "running")',
    );
    expect(db._executions.get('exec-5')).toMatchObject({
      status: FlowStatus.Running,
      retryCount: 1,
    });
    expect(db._deadLetters.get('exec-5')?.metadata).toEqual(before);
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
