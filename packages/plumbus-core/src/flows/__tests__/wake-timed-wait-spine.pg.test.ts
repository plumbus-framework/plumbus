import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { flowExecutionsDdl, tenantDurableDdl } from '../../durable/apply-ddl.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';
import {
  listUnpublishedOutbox,
  loadExecutionState,
  publishOutboxToSpine,
} from '../../durable/postgres-persist.js';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import type { ExecutionContext } from '../../types/context.js';
import { FlowStepType, FlowWakeSkipReason } from '../../types/enums.js';
import type { AuthContext } from '../../types/security.js';
import { createFlowEngine } from '../engine.js';
import { createFlowService } from '../flow-service.js';
import { FlowRegistry } from '../registry.js';
import { FlowStatus } from '../state-machine.js';

// `ctx.flows.wake` with tenant data planes: the execution row and its durable wait live on the
// tenant's plane, and a worker only claims it through its hint on the spine (the coordination
// database), so the wake moves both.

const owner: AuthContext = {
  userId: 'owner-1',
  tenantId: 'tenant-a',
  roles: ['member'],
  scopes: [],
  provider: 'test',
};
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
const operator: AuthContext = {
  userId: 'operator-1',
  roles: ['system'],
  scopes: [],
  provider: 'test',
};

const workerCtx = (tenantId?: string) =>
  ({
    auth: { userId: 'system', roles: ['system'], scopes: [], provider: 'worker', tenantId },
    data: {},
    events: { emit: async () => undefined, emitMany: async () => undefined },
    flows: {},
    ai: {},
    audit: { record: async () => undefined },
    errors: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    time: { now: () => new Date() },
    config: {},
    security: {},
    translations: { locale: 'en', t: (key: string) => key },
  }) as never;

interface Hint {
  delivery_state: string;
  not_before: Date;
  expected_revision: number;
  due: boolean;
}

/**
 * A tenant plane whose next `transaction()` call first runs `hook`: arm it right before the
 * worker runs a delay step, and the hook lands between the step's wait and the retry schedule
 * the worker persists and publishes for it.
 */
function armableTransactions(db: PostgresJsDatabase, hook: () => Promise<void>) {
  const state = { armed: false };
  const proxied = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (...args: Parameters<PostgresJsDatabase['transaction']>) => {
        if (state.armed) {
          state.armed = false;
          await hook();
        }
        return target.transaction(...args);
      };
    },
  });
  return { db: proxied, state };
}

/**
 * Defers `then` on a query builder, and on every builder its methods return, until `before`
 * has run: the query is sent only after the hook.
 */
function deferThen<T extends object>(target: T, before: () => Promise<void>): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value !== 'function') return value;
      if (property === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          before().then(() => value.call(object, resolve, reject), reject);
      }
      return (...args: unknown[]) => {
        const out = value.apply(object, args);
        return out !== null && typeof out === 'object' ? deferThen(out, before) : out;
      };
    },
  });
}

/**
 * A tenant plane whose first `select` after its next `transaction()` call first runs `hook`.
 * Armed before a worker runs a delay step, that select is the worker's read-back after it
 * persisted and published the wait's retry schedule (the carry of an early wake).
 */
function armableReadBack(db: PostgresJsDatabase, hook: () => Promise<void>) {
  const state = { armed: false, afterTransaction: false };
  const proxied = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async (...args: Parameters<PostgresJsDatabase['transaction']>) => {
          if (state.armed) {
            state.armed = false;
            state.afterTransaction = true;
          }
          return target.transaction(...args);
        };
      }
      if (property === 'select' && state.afterTransaction) {
        state.afterTransaction = false;
        return (...args: Parameters<PostgresJsDatabase['select']>) =>
          deferThen(target.select(...args), hook);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { db: proxied, state };
}

describe('ctx.flows.wake with tenant data planes', () => {
  let harness: DurableTestHarness;
  /** The database the resolver hands back for tenant-a: its own plane, or the spine's handle. */
  let plane: PostgresJsDatabase;

  afterEach(async () => {
    await harness?.close();
  });

  async function setup(
    options: {
      tenantDb?: (db: PostgresJsDatabase) => PostgresJsDatabase;
      untenanted?: 'refuse' | 'control-plane';
      /** The resolver returns the spine's own handle for the tenant (one database for both). */
      samePlane?: boolean;
    } = {},
  ) {
    harness = await createDurableTestHarness();
    plane = harness.tenantDb;
    if (options.samePlane) {
      plane = harness.spineDb;
      for (const statement of `${tenantDurableDdl(harness.coreSchema)}\n${flowExecutionsDdl()}`
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)) {
        await harness.spineDb.execute(sql.raw(`${statement};`));
      }
    }
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'durable-sleepy',
        domain: 'durable',
        input: z.object({ ref: z.string() }),
        steps: [
          { name: 'pause', type: FlowStepType.Delay, duration: '1h' },
          { name: 'continueWork', type: FlowStepType.Capability, capability: 'durable.continue' },
        ],
      }),
    );
    registry.register(
      defineFlow({
        name: 'durable-sleepy-twice',
        domain: 'durable',
        input: z.object({ ref: z.string() }),
        steps: [
          { name: 'pause', type: FlowStepType.Delay, duration: '1h' },
          { name: 'continueWork', type: FlowStepType.Capability, capability: 'durable.continue' },
          { name: 'pauseShort', type: FlowStepType.Delay, duration: '30m' },
          { name: 'finishWork', type: FlowStepType.Capability, capability: 'durable.finish' },
        ],
      }),
    );
    const calls: Array<{ userId?: string; tenantId?: string }> = [];
    const stepDeps = {
      executeCapability: async (_capability: string, ctx: ExecutionContext) => {
        calls.push({ userId: ctx.auth.userId, tenantId: ctx.auth.tenantId });
        return { success: true as const, data: {} };
      },
      evaluateCondition: () => true,
    };
    const makeEngine = (workerId: string, tenantDb: PostgresJsDatabase) =>
      createFlowEngine({
        db: harness.spineDb,
        registry,
        workerId,
        stepDeps,
        spineDispatch: {
          db: harness.spineDb,
          resolver: createSingleDataPlaneResolver(tenantDb, { coreSchema: harness.coreSchema }),
          coreSchema: harness.coreSchema,
          ...(options.untenanted ? { untenanted: options.untenanted } : {}),
        },
        flowLeaseDurationMs: 300_000,
      });
    const worker = makeEngine('worker-a', options.tenantDb ? options.tenantDb(plane) : plane);
    const other = makeEngine('worker-b', plane);
    // The API process: a request engine on the tenant's plane, like the server's per-plane engine.
    const audit = { record: vi.fn(async () => undefined) };
    const api = createFlowEngine({
      db: plane,
      registry,
      workerId: 'api-a',
      stepDeps,
      audit,
      spineDispatch: {
        db: harness.spineDb,
        resolver: createSingleDataPlaneResolver(plane, {
          coreSchema: harness.coreSchema,
        }),
        coreSchema: harness.coreSchema,
        ...(options.untenanted ? { untenanted: options.untenanted } : {}),
      },
    });
    return { registry, calls, worker, other, api, audit };
  }

  async function hints(executionId: string): Promise<Hint[]> {
    return (await harness.spineDb.execute(
      sql`SELECT delivery_state, not_before, expected_revision, not_before <= now() AS due
        FROM opaque_dispatch WHERE execution_id = ${executionId} ORDER BY expected_revision`,
    )) as unknown as Hint[];
  }

  async function durableWait(executionId: string) {
    const [wait] = (await plane.execute(
      sql.raw(
        `SELECT not_before <= now() AS due FROM ${harness.coreSchema}.wait_state
          WHERE execution_id = '${executionId}' AND state = 'waiting' ORDER BY created_at DESC LIMIT 1`,
      ),
    )) as unknown as Array<{ due: boolean }>;
    const outbox = (await plane.execute(
      sql.raw(
        `SELECT expected_revision, not_before <= now() AS due FROM ${harness.coreSchema}.dispatch_outbox
          WHERE execution_id = '${executionId}' ORDER BY expected_revision`,
      ),
    )) as unknown as Array<{ expected_revision: number; due: boolean }>;
    const state = await loadExecutionState(plane, executionId, harness.coreSchema);
    return {
      waitDue: wait?.due,
      outbox,
      state,
      stateDue: state?.wakeAt ? Date.parse(state.wakeAt) <= Date.now() : undefined,
    };
  }

  async function runToCompletion(
    engine: ReturnType<typeof createFlowEngine>,
    executionId: string,
  ): Promise<string> {
    let status = (await engine.runNext(executionId, workerCtx('tenant-a'))).status;
    while (status === FlowStatus.Running) {
      status = (await engine.runNext(executionId, workerCtx('tenant-a'))).status;
    }
    return status;
  }

  it('moves the plane row, the durable wait and the spine hint to now; another worker then runs the step once, as the owner', async () => {
    const { worker, other, api, calls } = await setup();
    const started = await worker.start('durable-sleepy', { ref: 'doc-7' }, owner);
    expect((await worker.claimNext(1)).map((row) => row.id)).toEqual([started.id]);
    expect((await worker.runNext(started.id, workerCtx('tenant-a'))).status).toBe(
      FlowStatus.Waiting,
    );
    const before = await hints(started.id);
    expect(before.map((hint) => [hint.delivery_state, hint.due])).toEqual([
      ['acknowledged', true],
      ['retry-scheduled', false],
    ]);
    const revision = (await loadExecutionState(harness.tenantDb, started.id, harness.coreSchema))
      ?.revision;
    expect(await other.claimNext(1)).toEqual([]);

    expect(await createFlowService(api, approver).wake(started.id)).toEqual({
      executionId: started.id,
      woken: true,
      status: FlowStatus.Waiting,
    });

    const after = await hints(started.id);
    expect(after.map((hint) => [hint.delivery_state, hint.due])).toEqual([
      ['acknowledged', true],
      ['retry-scheduled', true],
    ]);
    const durable = await durableWait(started.id);
    expect(durable.waitDue).toBe(true);
    expect(durable.stateDue).toBe(true);
    expect(durable.state).toMatchObject({ status: 'retry-scheduled', revision });
    expect(durable.outbox.at(-1)).toEqual({ expected_revision: revision, due: true });

    expect((await other.claimNext(1)).map((row) => row.id)).toEqual([started.id]);
    expect(await runToCompletion(other, started.id)).toBe(FlowStatus.Completed);
    expect(calls).toEqual([{ userId: 'owner-1', tenantId: 'tenant-a' }]);

    // Waking twice changes nothing more; a finished execution is left alone.
    expect(await api.wakeTimedWait(started.id, approver)).toMatchObject({
      woken: false,
      reason: FlowWakeSkipReason.Finished,
    });
    expect(await worker.claimNext(1)).toEqual([]);
  });

  it('is idempotent on the spine: a second wake is a no-op and only one worker claims the hint', async () => {
    const { worker, other, api, calls } = await setup();
    const started = await worker.start('durable-sleepy', { ref: 'r' }, owner);
    await worker.claimNext(1);
    await worker.runNext(started.id, workerCtx('tenant-a'));

    expect((await api.wakeTimedWait(started.id, approver)).woken).toBe(true);
    const first = await hints(started.id);
    expect(await api.wakeTimedWait(started.id, approver)).toEqual({
      executionId: started.id,
      woken: false,
      reason: FlowWakeSkipReason.AlreadyDue,
      status: FlowStatus.Waiting,
    });
    expect(await hints(started.id)).toEqual(first);

    const [byWorker, byOther] = await Promise.all([worker.claimNext(1), other.claimNext(1)]);
    const claimed = [...byWorker.map(() => worker), ...byOther.map(() => other)];
    expect(claimed).toHaveLength(1);
    expect(await runToCompletion(claimed[0] ?? worker, started.id)).toBe(FlowStatus.Completed);
    expect(calls).toHaveLength(1);
  });

  it("refuses another tenant's execution and an untenanted caller, leaving the hint as scheduled", async () => {
    const { worker, api, audit } = await setup();
    const started = await worker.start('durable-sleepy', { ref: 'r' }, owner);
    await worker.claimNext(1);
    await worker.runNext(started.id, workerCtx('tenant-a'));
    const before = await hints(started.id);

    await expect(api.wakeTimedWait(started.id, intruder)).rejects.toMatchObject({
      code: 'notFound',
      metadata: { reason: 'flow-execution-not-found' },
    });
    // Without untenanted control-plane flows there is nothing an untenanted caller may wake.
    await expect(api.wakeTimedWait(started.id, operator)).rejects.toMatchObject({
      code: 'forbidden',
      metadata: { reason: 'untenanted-flow-wake' },
    });
    await expect(api.wakeTimedWait('not-an-id', operator)).rejects.toMatchObject({
      code: 'forbidden',
    });
    // Both refusals are recorded, with the id only when it is well formed.
    expect(audit.record.mock.calls).toEqual([
      [
        'flow.wake.denied',
        {
          executionId: started.id,
          actor: 'intruder-1',
          tenantId: 'tenant-b',
          outcome: 'denied',
          reason: 'flow-execution-not-found',
        },
      ],
      [
        'flow.wake.denied',
        {
          executionId: started.id,
          actor: 'operator-1',
          tenantId: undefined,
          outcome: 'denied',
          reason: 'untenanted-flow-wake',
        },
      ],
      [
        'flow.wake.denied',
        {
          executionId: '(malformed)',
          actor: 'operator-1',
          tenantId: undefined,
          outcome: 'denied',
          reason: 'untenanted-flow-wake',
        },
      ],
    ]);
    expect(await hints(started.id)).toEqual(before);
    expect(await worker.claimNext(1)).toEqual([]);
  });

  it('wakes a tenant execution whose plane is the spine database itself through its hint', async () => {
    const { worker, other, api, calls } = await setup({ samePlane: true });
    const started = await worker.start('durable-sleepy', { ref: 'r' }, owner);
    expect((await worker.claimNext(1)).map((row) => row.id)).toEqual([started.id]);
    expect((await worker.runNext(started.id, workerCtx('tenant-a'))).status).toBe(
      FlowStatus.Waiting,
    );
    expect((await hints(started.id)).map((hint) => [hint.delivery_state, hint.due])).toEqual([
      ['acknowledged', true],
      ['retry-scheduled', false],
    ]);
    expect(await other.claimNext(1)).toEqual([]);

    expect(await api.wakeTimedWait(started.id, approver)).toEqual({
      executionId: started.id,
      woken: true,
      status: FlowStatus.Waiting,
    });
    expect((await hints(started.id)).map((hint) => [hint.delivery_state, hint.due])).toEqual([
      ['acknowledged', true],
      ['retry-scheduled', true],
    ]);
    expect((await durableWait(started.id)).stateDue).toBe(true);
    expect((await other.claimNext(1)).map((row) => row.id)).toEqual([started.id]);
    expect(await runToCompletion(other, started.id)).toBe(FlowStatus.Completed);
    expect(calls).toEqual([{ userId: 'owner-1', tenantId: 'tenant-a' }]);
  });

  it('publishes a due hint from an outbox row the pump had not published yet', async () => {
    const { worker, other, api, calls } = await setup();
    const started = await worker.start('durable-sleepy', { ref: 'r' }, owner);
    await worker.claimNext(1);
    await worker.runNext(started.id, workerCtx('tenant-a'));
    // As if the post-commit hint publication had failed: no hint for the sleeping revision.
    const revision =
      (await loadExecutionState(harness.tenantDb, started.id, harness.coreSchema))?.revision ?? 0;
    await harness.spineDb.execute(
      sql`DELETE FROM opaque_dispatch WHERE execution_id = ${started.id} AND expected_revision = ${revision}`,
    );
    await harness.tenantDb.execute(
      sql.raw(
        `UPDATE ${harness.coreSchema}.dispatch_outbox SET published_at = NULL, spine_row_id = NULL
          WHERE execution_id = '${started.id}' AND expected_revision = ${revision}`,
      ),
    );

    expect((await api.wakeTimedWait(started.id, approver)).woken).toBe(true);
    const pending = await listUnpublishedOutbox(harness.tenantDb, harness.coreSchema);
    expect(pending).toHaveLength(1);
    expect(Date.parse(pending[0]?.notBefore ?? '')).toBeLessThanOrEqual(Date.now());
    // The pump's publication.
    for (const row of pending) {
      await publishOutboxToSpine(
        harness.tenantDb,
        harness.spineDb,
        row,
        `disp:${row.executionId}:${row.expectedRevision}`,
        new Date().toISOString(),
        harness.coreSchema,
      );
    }
    expect((await other.claimNext(1)).map((row) => row.id)).toEqual([started.id]);
    expect(await runToCompletion(other, started.id)).toBe(FlowStatus.Completed);
    expect(calls).toHaveLength(1);
  });

  it('carries a wake that lands between the wait and its published retry schedule over to the new hint', async () => {
    let wakeDuringSchedule: Promise<unknown> | undefined;
    let executionId = '';
    let apiEngine: ReturnType<typeof createFlowEngine> | undefined;
    let armed: { armed: boolean } = { armed: false };
    const { worker, other, api, calls } = await setup({
      tenantDb: (db) => {
        const wrapped = armableTransactions(db, async () => {
          // The flow row is already waiting; the retry schedule is not persisted yet.
          wakeDuringSchedule = apiEngine?.wakeTimedWait(executionId, approver);
          await wakeDuringSchedule;
        });
        armed = wrapped.state;
        return wrapped.db;
      },
    });
    apiEngine = api;
    const started = await worker.start('durable-sleepy', { ref: 'r' }, owner);
    executionId = started.id;
    expect((await worker.claimNext(1)).map((row) => row.id)).toEqual([started.id]);
    armed.armed = true;
    expect((await worker.runNext(started.id, workerCtx('tenant-a'))).status).toBe(
      FlowStatus.Waiting,
    );
    expect(await wakeDuringSchedule).toMatchObject({ woken: true });

    const after = await hints(started.id);
    expect(after.at(-1)).toMatchObject({ delivery_state: 'retry-scheduled', due: true });
    expect((await durableWait(started.id)).stateDue).toBe(true);
    expect((await other.claimNext(1)).map((row) => row.id)).toEqual([started.id]);
    expect(await runToCompletion(other, started.id)).toBe(FlowStatus.Completed);
    expect(calls).toHaveLength(1);
  });

  it("does not carry a wake over to a later wait another worker entered before this worker's read-back", async () => {
    let executionId = '';
    let engines:
      | { api: ReturnType<typeof createFlowEngine>; other: ReturnType<typeof createFlowEngine> }
      | undefined;
    let armed: { armed: boolean } = { armed: false };
    let interleaved = false;
    const { worker, other, api, calls } = await setup({
      tenantDb: (db) => {
        const wrapped = armableReadBack(db, async () => {
          if (!engines) return;
          // After this worker published the 1 h wait's hint and before it reads the row back:
          // a wake makes it due, another worker claims it and runs into the 30 min delay.
          expect((await engines.api.wakeTimedWait(executionId, approver)).woken).toBe(true);
          expect((await engines.other.claimNext(1)).map((row) => row.id)).toEqual([executionId]);
          let status = (await engines.other.runNext(executionId, workerCtx('tenant-a'))).status;
          while (status === FlowStatus.Running) {
            status = (await engines.other.runNext(executionId, workerCtx('tenant-a'))).status;
          }
          expect(status).toBe(FlowStatus.Waiting);
          interleaved = true;
        });
        armed = wrapped.state;
        return wrapped.db;
      },
    });
    engines = { api, other };
    const started = await worker.start('durable-sleepy-twice', { ref: 'r' }, owner);
    executionId = started.id;
    expect((await worker.claimNext(1)).map((row) => row.id)).toEqual([started.id]);
    armed.armed = true;
    expect((await worker.runNext(started.id, workerCtx('tenant-a'))).status).toBe(
      FlowStatus.Waiting,
    );
    expect(interleaved).toBe(true);
    expect(calls).toEqual([{ userId: 'owner-1', tenantId: 'tenant-a' }]);

    // The 30 min wait keeps its own time: row, durable wait and hint alike.
    const row = await other.status(started.id);
    expect(row.status).toBe(FlowStatus.Waiting);
    const latest = (await hints(started.id)).at(-1);
    expect(latest).toMatchObject({ delivery_state: 'retry-scheduled', due: false });
    expect(Date.parse(String(latest?.not_before))).toBeGreaterThan(Date.now() + 25 * 60_000);
    const durable = await durableWait(started.id);
    expect(durable.stateDue).toBe(false);
    expect(durable.waitDue).toBe(false);
    expect(await worker.claimNext(1)).toEqual([]);
    expect(await other.claimNext(1)).toEqual([]);
  });

  it('wakes an untenanted control-plane execution on the spine for an untenanted caller only', async () => {
    const { worker, api, calls } = await setup({ untenanted: 'control-plane' });
    for (const statement of flowExecutionsDdl()
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await harness.spineDb.execute(sql.raw(`${statement};`));
    }
    const started = await worker.start('durable-sleepy', { ref: 'r' }, operator);
    expect((await worker.claimNext(5)).map((row) => row.id)).toEqual([started.id]);
    expect((await worker.runNext(started.id, workerCtx())).status).toBe(FlowStatus.Waiting);
    expect(await worker.claimNext(5)).toEqual([]);

    // A tenant caller looks on its own plane only.
    await expect(api.wakeTimedWait(started.id, approver)).rejects.toMatchObject({
      code: 'notFound',
    });
    expect((await api.wakeTimedWait(started.id, operator)).woken).toBe(true);
    expect((await worker.claimNext(5)).map((row) => row.id)).toEqual([started.id]);
    let status = (await worker.runNext(started.id, workerCtx())).status;
    while (status === FlowStatus.Running) {
      status = (await worker.runNext(started.id, workerCtx())).status;
    }
    expect(status).toBe(FlowStatus.Completed);
    expect(calls).toEqual([{ userId: 'operator-1', tenantId: undefined }]);
  });
});
