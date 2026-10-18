import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { PlumbusError } from '../../errors/index.js';
import type { ExecutionContext } from '../../types/context.js';
import { FlowWakeSkipReason } from '../../types/enums.js';
import type { FlowStep } from '../../types/flow.js';
import type { AuthContext } from '../../types/security.js';
import { createFlowEngine } from '../engine.js';
import { createFlowService } from '../flow-service.js';
import { FlowRegistry } from '../registry.js';
import { flowExecutionsTable } from '../schema.js';
import { startPostgres } from './postgres-fixture.js';

// `ctx.flows.wake` on the shared database: the execution row is the whole story, claimed by
// `wake_at <= now()` in database time.

let pg: Awaited<ReturnType<typeof startPostgres>>;
beforeAll(async () => {
  pg = await startPostgres();
}, 30_000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.reset();
});

/** The user whose execution sleeps. */
const owner: AuthContext = {
  userId: 'owner-1',
  tenantId: 'tenant-a',
  roles: ['member'],
  scopes: ['documents:read'],
  provider: 'test',
};
/** Another user of the same tenant who unblocks it. */
const approver: AuthContext = {
  userId: 'approver-1',
  tenantId: 'tenant-a',
  roles: ['admin'],
  scopes: [],
  provider: 'test',
};
const intruder: AuthContext = {
  userId: 'intruder-1',
  tenantId: 'tenant-b',
  roles: ['admin'],
  scopes: [],
  provider: 'test',
};
const untenanted: AuthContext = {
  userId: 'operator-1',
  roles: ['system'],
  scopes: [],
  provider: 'test',
};

const sleepySteps: FlowStep[] = [
  { name: 'pause', type: 'delay', duration: '1h' },
  { name: 'continueWork', type: 'capability', capability: 'test.continueWork' },
];

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function workerContext(): ExecutionContext {
  return {
    auth: { userId: 'system-flow-runner', roles: ['system'], scopes: [], provider: 'worker' },
    ai: {},
    data: {},
    events: {},
    flows: {},
    logger,
  } as unknown as ExecutionContext;
}

interface StepCall {
  capability: string;
  userId?: string;
  tenantId?: string;
  roles: string[];
}

function setup(
  options: {
    steps?: FlowStep[];
    retry?: Record<string, unknown>;
    execute?: (capability: string, ctx: ExecutionContext) => Promise<{ success: boolean }>;
  } = {},
) {
  const calls: StepCall[] = [];
  const registry = new FlowRegistry();
  registry.register(
    defineFlow({
      name: 'sleepy',
      domain: 'test',
      input: z.object({ ref: z.string() }),
      steps: options.steps ?? sleepySteps,
      ...(options.retry ? { retry: options.retry } : {}),
    } as never),
  );
  registry.register(
    defineFlow({
      name: 'listener',
      domain: 'test',
      input: z.object({}),
      steps: [{ name: 'listen', type: 'wait', event: 'test.signal' }],
    }),
  );
  const audit = { record: vi.fn(async () => undefined) };
  const engineOn = (db: PostgresJsDatabase, workerId: string) =>
    createFlowEngine({
      db,
      registry,
      workerId,
      logger,
      audit,
      flowHeartbeatIntervalMs: 10_000,
      stepDeps: {
        executeCapability: async (capability, ctx) => {
          calls.push({
            capability,
            userId: ctx.auth.userId,
            tenantId: ctx.auth.tenantId,
            roles: ctx.auth.roles,
          });
          return options.execute ? options.execute(capability, ctx) : { success: true, data: {} };
        },
        evaluateCondition: () => true,
      },
    });
  // The worker, and a request-side engine on its own connection (the API process).
  const worker = engineOn(pg.db, 'worker-a');
  const api = engineOn(pg.connect().db, 'api-a');
  return { registry, calls, audit, worker, api, engineOn };
}

async function readRow(id: string) {
  const [row] = await pg.db
    .select()
    .from(flowExecutionsTable)
    .where(eq(flowExecutionsTable.id, id));
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

/** Start `sleepy` as `owner` and run it into its one-hour delay. */
async function sleepingExecution(engine: Engine) {
  const execution = await engine.start('sleepy', { ref: 'doc-7' }, owner);
  expect((await engine.runNext(execution.id, workerContext())).status).toBe('waiting');
  return execution.id;
}

type Engine = ReturnType<typeof setup>['worker'];

/** Run a claimed execution until it stops running, as the worker's flow cycle does. */
async function runClaimed(engine: Engine, row: { id: string; leaseToken: string | null }) {
  let status = 'running';
  while (status === 'running') {
    status = (await engine.runNext(row.id, workerContext(), row.leaseToken ?? undefined)).status;
  }
}

/** Claim and drain with each engine until none claims anything; returns how many claims ran. */
async function drain(...engines: Engine[]) {
  let ran = 0;
  for (let round = 0; round < 10; round += 1) {
    let claimedThisRound = 0;
    for (const engine of engines) {
      for (const row of await engine.claimNext(5)) {
        claimedThisRound += 1;
        ran += 1;
        await runClaimed(engine, row);
      }
    }
    if (claimedThisRound === 0) return ran;
  }
  return ran;
}

/**
 * Wraps a database so `hook` runs once just before the first UPDATE it sends — the gap between
 * a wake's read of the execution and its fenced write.
 */
function withHookBeforeFirstUpdate(
  db: PostgresJsDatabase,
  hook: () => Promise<void>,
): PostgresJsDatabase {
  let fired = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'update') return Reflect.get(target, property, receiver);
      return (table: typeof flowExecutionsTable) => {
        const builder = target.update(table);
        return {
          set: (values: Record<string, unknown>) => {
            const assigned = builder.set(values as never);
            return {
              where: (condition: Parameters<typeof assigned.where>[0]) => {
                const query = assigned.where(condition);
                return {
                  then: (
                    resolve: (value: unknown) => unknown,
                    reject: (error: unknown) => unknown,
                  ) =>
                    (async () => {
                      if (!fired) {
                        fired = true;
                        await hook();
                      }
                      return query;
                    })().then(resolve, reject),
                };
              },
            };
          },
        };
      };
    },
  });
}

describe('ctx.flows.wake on the shared database', () => {
  it('makes a sleeping execution due now; the next step runs at once under the owner, with its identity, input and state unchanged', async () => {
    const { worker, api, calls, audit } = setup();
    const id = await sleepingExecution(worker);
    expect(await worker.claimNext(5)).toEqual([]);
    const before = await readRow(id);
    expect(before.wakeAt?.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    const result = await createFlowService(api, approver).wake(id);
    expect(result).toEqual({ executionId: id, woken: true, status: 'waiting' });

    const after = await readRow(id);
    expect(after.wakeAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect({
      status: after.status,
      input: after.input,
      state: after.state,
      currentStep: after.currentStep,
      actor: after.actor,
      tenantId: after.tenantId,
      authSnapshotJson: after.authSnapshotJson,
      leaseToken: after.leaseToken,
      waitKind: after.waitKind,
      retryCount: after.retryCount,
      stepHistory: after.stepHistory,
    }).toEqual({
      status: before.status,
      input: before.input,
      state: before.state,
      currentStep: before.currentStep,
      actor: before.actor,
      tenantId: before.tenantId,
      authSnapshotJson: before.authSnapshotJson,
      leaseToken: before.leaseToken,
      waitKind: 'delay',
      retryCount: before.retryCount,
      stepHistory: before.stepHistory,
    });

    expect(await drain(worker)).toBe(1);
    expect((await worker.status(id)).status).toBe('completed');
    // The woken step ran once, as the user who started the flow — not as the approver.
    expect(calls).toEqual([
      {
        capability: 'test.continueWork',
        userId: 'owner-1',
        tenantId: 'tenant-a',
        roles: ['member'],
      },
    ]);
    expect(audit.record).toHaveBeenCalledWith('flow.woken.sleepy', {
      executionId: id,
      flowName: 'sleepy',
      actor: 'approver-1',
      tenantId: 'tenant-a',
      step: 'continueWork',
      waitKind: 'delay',
      scheduledFor: before.wakeAt?.toISOString(),
      outcome: 'success',
    });
    // No payload in the audit record.
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('doc-7');
  });

  it('is idempotent: a second wake is a no-op and the step still runs once', async () => {
    const { worker, api, calls, engineOn } = setup();
    const id = await sleepingExecution(worker);
    expect((await api.wakeTimedWait(id, approver)).woken).toBe(true);
    const dueAt = (await readRow(id)).wakeAt;
    expect(await api.wakeTimedWait(id, approver)).toEqual({
      executionId: id,
      woken: false,
      reason: FlowWakeSkipReason.AlreadyDue,
      status: 'waiting',
    });
    expect((await readRow(id)).wakeAt).toEqual(dueAt);

    const second = engineOn(pg.connect().db, 'worker-b');
    const [byWorker, bySecond] = await Promise.all([worker.claimNext(5), second.claimNext(5)]);
    const claimed = [
      ...byWorker.map((row) => ({ engine: worker, row })),
      ...bySecond.map((row) => ({ engine: second, row })),
    ];
    expect(claimed.map(({ row }) => row.id)).toEqual([id]);
    for (const { engine, row } of claimed) await runClaimed(engine, row);
    expect(await drain(worker, second)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('lets exactly one of several concurrent wakes win', async () => {
    const { worker, calls, engineOn } = setup();
    const id = await sleepingExecution(worker);
    const wakers = [1, 2, 3, 4].map((n) => engineOn(pg.connect().db, `api-${n}`));
    const results = await Promise.all(wakers.map((engine) => engine.wakeTimedWait(id, approver)));
    expect(results.filter((result) => result.woken)).toHaveLength(1);
    for (const result of results.filter((candidate) => !candidate.woken)) {
      expect(result.reason).toBe(FlowWakeSkipReason.AlreadyDue);
    }
    expect(await drain(worker, ...wakers)).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('loses cleanly to the scheduled wake-up: a worker that claimed the due execution first runs the step once', async () => {
    const { worker, calls, engineOn } = setup();
    const id = await sleepingExecution(worker);
    const second = engineOn(pg.connect().db, 'worker-b');
    let claimedByScheduledWake: Array<{ id: string; leaseToken: string | null }> = [];
    // Between the wake's read and its write, the scheduled time arrives and a worker claims it.
    const racingApi = engineOn(
      withHookBeforeFirstUpdate(pg.connect().db, async () => {
        await pg.sql`UPDATE flow_executions SET wake_at = now() - interval '1 second' WHERE id = ${id}`;
        claimedByScheduledWake = await second.claimNext(5);
      }),
      'api-racing',
    );
    const result = await racingApi.wakeTimedWait(id, approver);
    expect(claimedByScheduledWake.map((row) => row.id)).toEqual([id]);
    expect(result).toEqual({
      executionId: id,
      woken: false,
      reason: FlowWakeSkipReason.WaitChanged,
      status: 'running',
    });
    for (const row of claimedByScheduledWake) await runClaimed(second, row);
    expect(await drain(second, worker)).toBe(0);
    expect(calls).toHaveLength(1);
    expect((await worker.status(id)).status).toBe('completed');
  });

  it('races the scheduled wake-up without running the step twice', async () => {
    const { worker, calls, engineOn } = setup({
      steps: [
        { name: 'pause', type: 'delay', duration: '300ms' },
        { name: 'continueWork', type: 'capability', capability: 'test.continueWork' },
      ],
    });
    const id = await sleepingExecution(worker);
    const second = engineOn(pg.connect().db, 'worker-b');
    const api = engineOn(pg.connect().db, 'api-b');
    const wakeAt = (await readRow(id)).wakeAt?.getTime() ?? Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, wakeAt - Date.now())));
    const [wake] = await Promise.all([api.wakeTimedWait(id, approver), drain(second)]);
    expect([true, false]).toContain(wake.woken);
    if (!wake.woken) {
      expect([
        FlowWakeSkipReason.AlreadyDue,
        FlowWakeSkipReason.WaitChanged,
        FlowWakeSkipReason.NotWaiting,
        FlowWakeSkipReason.Finished,
      ]).toContain(wake.reason);
    }
    await drain(worker, second);
    expect(calls).toHaveLength(1);
    expect((await worker.status(id)).status).toBe('completed');
  });

  it('is a no-op when the wait moved on between the read and the write', async () => {
    const { worker, calls, engineOn } = setup();
    const id = await sleepingExecution(worker);
    const racingApi = engineOn(
      withHookBeforeFirstUpdate(pg.connect().db, async () => {
        await worker.cancel(id);
      }),
      'api-racing',
    );
    expect(await racingApi.wakeTimedWait(id, approver)).toEqual({
      executionId: id,
      woken: false,
      reason: FlowWakeSkipReason.WaitChanged,
      status: 'cancelled',
    });
    expect(calls).toHaveLength(0);
  });

  it('answers why it left an execution alone: not waiting, waiting for an event, finished', async () => {
    const { worker, api } = setup();
    const created = await worker.start('sleepy', { ref: 'r' }, owner);
    expect(await api.wakeTimedWait(created.id, approver)).toEqual({
      executionId: created.id,
      woken: false,
      reason: FlowWakeSkipReason.NotWaiting,
      status: 'created',
    });

    const listening = await worker.start('listener', {}, owner);
    expect((await worker.runNext(listening.id, workerContext())).status).toBe('waiting');
    expect(await api.wakeTimedWait(listening.id, approver)).toMatchObject({
      woken: false,
      reason: FlowWakeSkipReason.NotTimedWait,
      status: 'waiting',
    });
    expect((await readRow(listening.id)).waitingForEvent).toBe('test.signal');

    const sleeping = await sleepingExecution(worker);
    await worker.cancel(sleeping);
    expect(await api.wakeTimedWait(sleeping, approver)).toMatchObject({
      woken: false,
      reason: FlowWakeSkipReason.Finished,
      status: 'cancelled',
    });

    const done = await sleepingExecution(worker);
    await api.wakeTimedWait(done, approver);
    await drain(worker);
    expect(await api.wakeTimedWait(done, approver)).toMatchObject({
      woken: false,
      reason: FlowWakeSkipReason.Finished,
      status: 'completed',
    });
  });

  it("refuses another tenant's execution, an untenanted caller, an unknown id and a malformed id alike, without touching the row", async () => {
    const { worker, api, audit } = setup();
    const id = await sleepingExecution(worker);
    const before = await readRow(id);
    // A caller-controlled string of any length: never copied into the record, log or error.
    const malformed = `${'x'.repeat(4096)}-caller-marker`;
    const unknown = '00000000-0000-4000-8000-000000000000';
    const errors: unknown[] = [];
    for (const [caller, executionId] of [
      [intruder, id],
      [untenanted, id],
      [approver, unknown],
      [approver, malformed],
    ] as const) {
      const error = await createFlowService(api, caller)
        .wake(executionId)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PlumbusError);
      expect(error).toMatchObject({
        code: 'notFound',
        metadata: { reason: 'flow-execution-not-found' },
      });
      errors.push(error);
    }
    expect((await readRow(id)).wakeAt).toEqual(before.wakeAt);
    const denials = audit.record.mock.calls.filter(
      (call: unknown[]) => call[0] === 'flow.wake.denied',
    ) as unknown as [string, Record<string, unknown>][];
    expect(denials.map(([, record]) => [record.executionId, record.actor])).toEqual([
      [id, 'intruder-1'],
      [id, 'operator-1'],
      [unknown, 'approver-1'],
      ['(malformed)', 'approver-1'],
    ]);
    for (const [, record] of denials) {
      expect(record).toMatchObject({ outcome: 'denied', reason: 'flow-execution-not-found' });
    }
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('caller-marker');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('caller-marker');
    expect(String((errors[3] as Error).message)).not.toContain('caller-marker');
    expect(await worker.claimNext(5)).toEqual([]);
  });

  it("leaves a retry backoff alone, so waking cannot spend a failing step's attempts at once", async () => {
    const { worker, api, calls } = setup({
      steps: [{ name: 'fetchRemote', type: 'capability', capability: 'test.fetchRemote' }],
      retry: { maxAttempts: 3, backoff: 'fixed', baseDelayMs: 60_000 },
      execute: async () => ({ success: false }),
    });
    const execution = await worker.start('sleepy', { ref: 'r' }, owner);
    expect((await worker.runNext(execution.id, workerContext())).status).toBe('waiting');
    const before = await readRow(execution.id);
    expect(before.waitKind).toBe('retry');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await api.wakeTimedWait(execution.id, approver)).toEqual({
        executionId: execution.id,
        woken: false,
        reason: FlowWakeSkipReason.RetryBackoff,
        status: 'waiting',
      });
    }
    const after = await readRow(execution.id);
    expect(after.wakeAt).toEqual(before.wakeAt);
    expect(after.retryCount).toBe(1);
    expect(await worker.claimNext(5)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("runs a compensation that wakes an execution under the flow's identity", async () => {
    const answers: unknown[] = [];
    let sleeping = '';
    const { registry, worker, calls } = setup({
      execute: async (capability, ctx) => {
        if (capability === 'test.unbook') answers.push(await ctx.flows.wake(sleeping));
        return { success: true };
      },
    });
    registry.register(
      defineFlow({
        name: 'booking',
        domain: 'test',
        input: z.object({}),
        steps: [
          { name: 'book', type: 'capability', capability: 'test.book', compensate: 'test.unbook' },
          { name: 'hold', type: 'delay', duration: '1h' },
        ],
      }),
    );
    sleeping = await sleepingExecution(worker);
    const booking = await worker.start('booking', {}, owner);
    let status = 'running';
    while (status === 'running') {
      status = (await worker.runNext(booking.id, workerContext())).status;
    }
    expect(status).toBe('waiting');

    await worker.cancel(booking.id);
    expect(answers).toEqual([{ executionId: sleeping, woken: true, status: 'waiting' }]);
    expect(await drain(worker)).toBe(1);
    expect(calls.map((call) => [call.capability, call.userId])).toEqual([
      ['test.book', 'owner-1'],
      ['test.unbook', 'owner-1'],
      ['test.continueWork', 'owner-1'],
    ]);
  });

  it("wakes from inside a flow step under the flow's own tenant, not the worker's", async () => {
    const { registry, worker, calls } = setup();
    const sleeping = await sleepingExecution(worker);
    const answers: unknown[] = [];
    registry.register(
      defineFlow({
        name: 'unblocker',
        domain: 'test',
        input: z.object({ target: z.string() }),
        steps: [{ name: 'unblock', type: 'capability', capability: 'test.unblock' }],
      }),
    );
    const unblockerEngine = createFlowEngine({
      db: pg.db,
      registry,
      workerId: 'worker-c',
      stepDeps: {
        executeCapability: async (_capability, ctx) => {
          answers.push(await ctx.flows.wake(sleeping));
          return { success: true, data: {} };
        },
        evaluateCondition: () => true,
      },
    });
    // The worker's base context is bound to an identity without a tenant: refused there.
    await expect(createFlowService(unblockerEngine, untenanted).wake(sleeping)).rejects.toThrow(
      /not found/,
    );
    const started = await unblockerEngine.start('unblocker', { target: sleeping }, approver);
    const ctx = workerContext();
    ctx.flows = createFlowService(unblockerEngine, untenanted);
    expect((await unblockerEngine.runNext(started.id, ctx)).status).toBe('completed');
    expect(answers).toEqual([{ executionId: sleeping, woken: true, status: 'waiting' }]);
    expect(await drain(worker)).toBe(1);
    expect(calls.map((call) => call.userId)).toEqual(['owner-1']);
  });

  it('publishes the wake to the delayed-wake schedule and the flow-step queue when they are wired', async () => {
    const { registry } = setup();
    const delayed: Array<{ executionId: string; wakeAt: Date }> = [];
    const enqueued: string[] = [];
    const engine = createFlowEngine({
      db: pg.db,
      registry,
      workerId: 'worker-q',
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
      onFlowDelayedSchedule: async (executionId, wakeAt) => {
        delayed.push({ executionId, wakeAt });
      },
      onFlowStepEnqueue: async (executionId) => {
        enqueued.push(executionId);
      },
    });
    const execution = await engine.start('sleepy', { ref: 'r' }, owner);
    await engine.runNext(execution.id, workerContext());
    expect(delayed).toHaveLength(1);
    expect(delayed[0]?.wakeAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    enqueued.length = 0;

    expect((await engine.wakeTimedWait(execution.id, approver)).woken).toBe(true);
    expect(delayed).toHaveLength(2);
    expect(delayed[1]?.executionId).toBe(execution.id);
    expect(delayed[1]?.wakeAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(enqueued).toEqual([execution.id]);
    // Claimable through the queue path too.
    expect((await engine.claimExecution(execution.id))?.id).toBe(execution.id);
  });
});
