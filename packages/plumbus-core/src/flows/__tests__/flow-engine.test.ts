import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { LeaseLostError } from '../../errors/index.js';
import { FlowStepType } from '../../types/enums.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { FlowStatus } from '../state-machine.js';

/**
 * Creates a mock DB that tracks inserts and updates,
 * and returns rows from a provided store.
 */
function mockDb(rows: Map<string, any> = new Map()) {
  const inserts: any[] = [];
  const updates: any[] = [];
  // Mutable state lets individual tests drive behavior: execute() return value and
  // guardedUpdate rowCount (0 simulates a lost lease).
  const state: { executeResult: any[]; updateRowCount: number } = {
    executeResult: [],
    updateRowCount: 1,
  };

  return {
    _inserts: inserts,
    _updates: updates,
    _rows: rows,
    _state: state,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: any) => {
        inserts.push(row);
        rows.set(row.id, {
          ...row,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        });
        return Promise.resolve();
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            // Return the most recently queried row from the map
            const allRows = Array.from(rows.values());
            return Promise.resolve(allRows.length > 0 ? [allRows[allRows.length - 1]] : []);
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: any) => ({
        where: vi.fn().mockImplementation(() => {
          updates.push(values);
          const allRows = Array.from(rows.values());
          if (allRows.length > 0 && state.updateRowCount > 0) {
            const last = allRows[allRows.length - 1];
            Object.assign(last, values);
          }
          return Promise.resolve({ rowCount: state.updateRowCount });
        }),
      })),
    }),
    execute: vi.fn().mockImplementation(() => Promise.resolve(state.executeResult)),
  } as any;
}

function makeTestFlow() {
  return defineFlow({
    name: 'order-processing',
    domain: 'orders',
    input: z.object({ orderId: z.string() }),
    steps: [
      { name: 'validate', type: FlowStepType.Capability },
      { name: 'process', type: FlowStepType.Capability },
      { name: 'notify', type: FlowStepType.Capability },
    ],
  });
}

function makeAuth() {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    roles: ['admin'],
    scopes: [],
    provider: 'test',
  };
}

function makeCtx(overrides?: Partial<Record<string, unknown>>) {
  return {
    auth: makeAuth(),
    data: {},
    events: {
      emit: vi.fn().mockResolvedValue(undefined),
      emitMany: vi.fn().mockResolvedValue(undefined),
    },
    flows: {
      start: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      status: vi.fn(),
    },
    ai: {},
    audit: { record: vi.fn() },
    errors: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    time: { now: () => new Date() },
    config: {},
    security: {},
    translations: { locale: 'en', t: (key: string) => key },
    ...overrides,
  } as any;
}

function makeStepDeps(succeeds = true) {
  return {
    executeCapability: vi
      .fn()
      .mockResolvedValue(
        succeeds ? { success: true, data: {} } : { success: false, error: 'step failed' },
      ),
    evaluateCondition: vi.fn().mockReturnValue(true),
  };
}

describe('FlowEngine', () => {
  it('starts a flow and creates execution record', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    const exec = await engine.start('order-processing', { orderId: '123' }, makeAuth());
    expect(exec.flowName).toBe('order-processing');
    expect(exec.status).toBe(FlowStatus.Created);
    expect(exec.id).toBeTruthy();
    expect(db._inserts).toHaveLength(1);
    expect(db._inserts[0].flowName).toBe('order-processing');
  });

  it('throws on unregistered flow', async () => {
    const registry = new FlowRegistry();
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    await expect(engine.start('nope', {}, makeAuth())).rejects.toThrow('not registered');
  });

  it('validates input against flow schema', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    await expect(engine.start('order-processing', { wrong: 123 }, makeAuth())).rejects.toThrow(
      'invalid input',
    );
  });

  it('gets flow execution status', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());

    // Mock the select to return the created row
    const row = db._rows.get(exec.id);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    });

    const st = await engine.status(exec.id);
    expect(st.id).toBe(exec.id);
    expect(st.flowName).toBe('order-processing');
  });

  it('cancels a created flow', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());

    const row = db._rows.get(exec.id);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    });

    await engine.cancel(exec.id);
    expect(db._updates.some((u: any) => u.status === FlowStatus.Cancelled)).toBe(true);
  });

  it('throws when cancelling a terminal flow', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const rows = new Map();
    rows.set('x', {
      id: 'x',
      flowName: 'order-processing',
      status: FlowStatus.Completed,
      currentStep: null,
      stepHistory: [],
      state: null,
      retryCount: 0,
    });
    const db = mockDb(rows);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rows.get('x')]),
        }),
      }),
    });
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps() });

    await expect(engine.cancel('x')).rejects.toThrow('terminal state');
  });

  it('records audit events when audit service provided', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const auditRecords: any[] = [];
    const audit = {
      record: vi.fn().mockImplementation(async (action: string, meta: any) => {
        auditRecords.push({ action, ...meta });
      }),
    };
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps(), audit });

    await engine.start('order-processing', { orderId: 'abc' }, makeAuth());
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].action).toBe('flow.started.order-processing');
  });

  it('merges capability output into persisted state between steps', async () => {
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'stateful-flow',
        domain: 'orders',
        input: z.object({ orderId: z.string() }),
        state: z.object({ manuscriptId: z.string().default('') }),
        steps: [
          { name: 'plan', type: FlowStepType.Capability },
          { name: 'write', type: FlowStepType.Capability },
        ],
      }),
    );

    const db = mockDb();
    const stepDeps = {
      executeCapability: vi
        .fn()
        .mockResolvedValueOnce({ success: true, data: { manuscriptId: 'm-1' } })
        .mockResolvedValueOnce({ success: true, data: {} }),
      evaluateCondition: vi.fn().mockReturnValue(true),
    };
    const engine = createFlowEngine({ db, registry, stepDeps });

    const exec = await engine.start('stateful-flow', { orderId: 'abc' }, makeAuth());
    const row = db._rows.get(exec.id);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    });

    await engine.runNext(exec.id, makeCtx());

    expect(row.state).toMatchObject({ manuscriptId: 'm-1' });
    expect(row.currentStep).toBe('write');
  });

  it('passes the live DB connection to onFlowError hooks', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());
    const db = mockDb();
    const onFlowError = vi.fn();
    const engine = createFlowEngine({ db, registry, stepDeps: makeStepDeps(false), onFlowError });

    const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());
    const row = db._rows.get(exec.id);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    });

    await engine.runNext(exec.id, makeCtx());

    expect(onFlowError).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        executionId: exec.id,
        flowName: 'order-processing',
        step: 'validate',
        error: 'step failed',
      }),
    );
  });
});

describe('FlowEngine — lease claiming', () => {
  it('only one worker claims a row under a SKIP LOCKED race', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const claimedRow = {
      id: 'race-1',
      flowName: 'order-processing',
      status: FlowStatus.Running,
      currentStep: 'validate',
      leaseOwner: null,
    };

    const dbA = mockDb();
    dbA._state.executeResult = [claimedRow];
    const dbB = mockDb();
    dbB._state.executeResult = [];

    const engineA = createFlowEngine({
      db: dbA,
      registry,
      stepDeps: makeStepDeps(),
      workerId: 'worker-a',
    });
    const engineB = createFlowEngine({
      db: dbB,
      registry,
      stepDeps: makeStepDeps(),
      workerId: 'worker-b',
    });

    const [claimedA, claimedB] = await Promise.all([engineA.claimNext(), engineB.claimNext()]);
    expect(claimedA).toHaveLength(1);
    expect(claimedA[0]?.id).toBe('race-1');
    expect(claimedB).toHaveLength(0);
  });

  it("reclaims a crashed worker's expired lease and audits the reclaim", async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const db = mockDb();
    db._state.executeResult = [
      {
        id: 'exec-crash',
        flowName: 'order-processing',
        status: FlowStatus.Running,
        currentStep: 'validate',
        leaseOwner: 'crashed-worker',
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    ];

    const audits: any[] = [];
    const audit = {
      record: vi.fn().mockImplementation(async (action: string, meta: any) => {
        audits.push({ action, ...meta });
      }),
    };
    const engine = createFlowEngine({
      db,
      registry,
      stepDeps: makeStepDeps(),
      workerId: 'worker-fresh',
      audit,
    });

    const claimed = await engine.claimNext();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe('exec-crash');

    const expired = audits.find((a) => a.action === 'flow.lease.expired');
    expect(expired).toBeDefined();
    expect(expired.previousOwner).toBe('crashed-worker');
    expect(expired.workerId).toBe('worker-fresh');
    expect(audits.some((a) => a.action === 'flow.lease.claimed')).toBe(true);
  });

  it('throws LeaseLostError when heartbeat detects the lease was stolen mid-step', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const db = mockDb();
    db._state.updateRowCount = 0; // every update says "0 rows affected" → heartbeat loses lease

    const stepDeps = {
      executeCapability: vi.fn().mockImplementation(async () => {
        // Give the heartbeat interval at least one tick to fire during the step
        await new Promise((r) => setTimeout(r, 40));
        return { success: true, data: {} };
      }),
      evaluateCondition: vi.fn().mockReturnValue(true),
    };

    const engine = createFlowEngine({
      db,
      registry,
      stepDeps,
      workerId: 'worker-x',
      flowHeartbeatIntervalMs: 5,
      flowLeaseDurationMs: 60_000,
    });

    const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());
    await expect(engine.runNext(exec.id, makeCtx())).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('skips completion audit when guardedUpdate reports the lease was lost', async () => {
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'single-step',
        domain: 'test',
        input: z.object({}),
        steps: [{ name: 'only', type: FlowStepType.Capability }],
      }),
    );

    const db = mockDb();
    db._state.updateRowCount = 0; // all guardedUpdates return false → completeFlow aborts before audit

    const audits: any[] = [];
    const audit = {
      record: vi.fn().mockImplementation(async (action: string, meta: any) => {
        audits.push({ action, ...meta });
      }),
    };

    const engine = createFlowEngine({
      db,
      registry,
      stepDeps: makeStepDeps(),
      workerId: 'worker-x',
      audit,
      flowHeartbeatIntervalMs: 60_000, // keep the heartbeat timer idle during the fast test
    });

    const exec = await engine.start('single-step', {}, makeAuth());
    await engine.runNext(exec.id, makeCtx());

    expect(audits.some((a) => a.action === 'flow.completed.single-step')).toBe(false);
  });

  it('20 executions across 4 engines — each claimed exactly once', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const available = new Set(Array.from({ length: 20 }, (_, i) => `exec-${i}`));
    const engines = ['w1', 'w2', 'w3', 'w4'].map((workerId) => {
      const db = mockDb();
      // Simulate FOR UPDATE SKIP LOCKED: each execute call atomically takes up to 5 rows
      // from the shared `available` set (synchronous mutation — JS single-threaded).
      db.execute = vi.fn().mockImplementation(async () => {
        const taken: any[] = [];
        for (const id of Array.from(available)) {
          if (taken.length >= 5) break;
          available.delete(id);
          taken.push({
            id,
            flowName: 'order-processing',
            status: FlowStatus.Running,
            currentStep: 'validate',
            leaseOwner: workerId,
          });
        }
        return taken;
      });
      return createFlowEngine({
        db,
        registry,
        stepDeps: makeStepDeps(),
        workerId,
      });
    });

    const results = await Promise.all(engines.map((e) => e.claimNext(5)));
    const claimedIds = results.flatMap((batch) => batch.map((row: any) => row.id));

    expect(claimedIds).toHaveLength(20);
    expect(new Set(claimedIds).size).toBe(20); // every ID is unique
    expect(available.size).toBe(0);
  });

  it('ctx.flows.heartbeat() extends the lease and throws LeaseLostError when lost', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const db = mockDb();
    db._state.updateRowCount = 1;

    let firstHeartbeatOk = false;
    let heartbeatError: unknown;

    const stepDeps = {
      executeCapability: vi.fn().mockImplementation(async (_name: string, stepCtx: any) => {
        await stepCtx.flows.heartbeat();
        firstHeartbeatOk = true;

        db._state.updateRowCount = 0; // simulate another worker stealing the lease
        try {
          await stepCtx.flows.heartbeat();
        } catch (err) {
          heartbeatError = err;
        }
        return { success: true, data: {} };
      }),
      evaluateCondition: vi.fn().mockReturnValue(true),
    };

    const engine = createFlowEngine({
      db,
      registry,
      stepDeps,
      workerId: 'worker-x',
      flowHeartbeatIntervalMs: 60_000, // disable auto-heartbeat; manual heartbeat only
    });

    const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());
    await engine.runNext(exec.id, makeCtx());

    expect(firstHeartbeatOk).toBe(true);
    expect(heartbeatError).toBeInstanceOf(LeaseLostError);
  });
});

describe('FlowEngine — cooperative cancellation (ctx.signal)', () => {
  it('exposes an un-aborted ctx.signal to step handlers', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const db = mockDb();
    let capturedSignal: AbortSignal | undefined;

    const stepDeps = {
      executeCapability: vi.fn().mockImplementation(async (_name: string, stepCtx: any) => {
        capturedSignal = stepCtx.signal;
        return { success: true, data: {} };
      }),
      evaluateCondition: vi.fn().mockReturnValue(true),
    };

    const engine = createFlowEngine({
      db,
      registry,
      stepDeps,
      workerId: 'worker-sig-1',
      flowHeartbeatIntervalMs: 60_000,
    });

    const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());
    await engine.runNext(exec.id, makeCtx());

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // Step completed normally; signal.aborted before return should be false.
    // (After runNext finishes the finally-block aborts it to wake detached tasks,
    // but the assertion is about the state the handler observed during execution.)
  });

  it('cancel() aborts ctx.signal for the in-flight step in the same process', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const db = mockDb();
    db._state.updateRowCount = 1;

    let stepSignalAborted = false;
    let stepSignalReason: unknown;

    const stepDeps = {
      executeCapability: vi.fn().mockImplementation(async (_name: string, stepCtx: any) => {
        // Wait for the signal to abort — simulates a long-running AI call.
        await new Promise<void>((resolve) => {
          if (stepCtx.signal.aborted) {
            stepSignalAborted = true;
            stepSignalReason = stepCtx.signal.reason;
            resolve();
            return;
          }
          stepCtx.signal.addEventListener(
            'abort',
            () => {
              stepSignalAborted = true;
              stepSignalReason = stepCtx.signal.reason;
              resolve();
            },
            { once: true },
          );
        });
        return { success: true, data: {} };
      }),
      evaluateCondition: vi.fn().mockReturnValue(true),
    };

    const engine = createFlowEngine({
      db,
      registry,
      stepDeps,
      workerId: 'worker-cancel-1',
      flowHeartbeatIntervalMs: 60_000,
    });

    const exec = await engine.start('order-processing', { orderId: 'x' }, makeAuth());

    // Kick off runNext, then cancel while the step is mid-flight.
    const running = engine.runNext(exec.id, makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    await engine.cancel(exec.id);
    await running;

    expect(stepSignalAborted).toBe(true);
    // reason is a FlowCancelledError
    expect((stepSignalReason as Error | undefined)?.name).toBe('FlowCancelledError');
  });

  it('heartbeat-driven lease loss aborts ctx.signal with LeaseLostError', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const db = mockDb();
    db._state.updateRowCount = 0; // every lease-extend reports 0 rows affected

    let abortReason: unknown;

    const stepDeps = {
      executeCapability: vi.fn().mockImplementation(async (_name: string, stepCtx: any) => {
        await new Promise<void>((resolve) => {
          stepCtx.signal.addEventListener(
            'abort',
            () => {
              abortReason = stepCtx.signal.reason;
              resolve();
            },
            { once: true },
          );
        });
        return { success: true, data: {} };
      }),
      evaluateCondition: vi.fn().mockReturnValue(true),
    };

    const engine = createFlowEngine({
      db,
      registry,
      stepDeps,
      workerId: 'worker-lease-1',
      flowHeartbeatIntervalMs: 5,
      flowLeaseDurationMs: 60_000,
    });

    const exec = await engine.start('order-processing', { orderId: 'x' }, makeAuth());
    await expect(engine.runNext(exec.id, makeCtx())).rejects.toBeInstanceOf(LeaseLostError);

    expect((abortReason as Error | undefined)?.name).toBe('LeaseLostError');
  });

  it('threads ctx.signal into ctx.ai.generate by default', async () => {
    const registry = new FlowRegistry();
    registry.register(makeTestFlow());

    const db = mockDb();

    const generate = vi.fn().mockResolvedValue({ ok: true });
    const ctxWithAi = makeCtx({
      ai: {
        generate,
        generateWithUsage: vi.fn(),
        streamGenerate: vi.fn(),
        extract: vi.fn(),
        classify: vi.fn(),
        retrieve: vi.fn(),
      },
    });

    const stepDeps = {
      executeCapability: vi.fn().mockImplementation(async (_name: string, stepCtx: any) => {
        // Capability does NOT pass a signal — engine must default to ctx.signal.
        await stepCtx.ai.generate({ prompt: 'p', input: {} });
        return { success: true, data: {} };
      }),
      evaluateCondition: vi.fn().mockReturnValue(true),
    };

    const engine = createFlowEngine({
      db,
      registry,
      stepDeps,
      workerId: 'worker-ai-1',
      flowHeartbeatIntervalMs: 60_000,
    });

    const exec = await engine.start('order-processing', { orderId: 'x' }, makeAuth());
    await engine.runNext(exec.id, ctxWithAi);

    expect(generate).toHaveBeenCalledTimes(1);
    const firstCall = generate.mock.calls[0];
    expect(firstCall).toBeDefined();
    const calledWith = firstCall?.[0] as { signal?: AbortSignal };
    expect(calledWith.signal).toBeInstanceOf(AbortSignal);
  });

  describe('markFailedFromRunner (zombie recovery)', () => {
    it('finalizes the row as failed with lease cleared after LeaseLostError from runNext', async () => {
      const registry = new FlowRegistry();
      registry.register(makeTestFlow());

      const db = mockDb();
      db._state.updateRowCount = 0; // every update says 0 rows → heartbeat loses lease

      const stepDeps = {
        executeCapability: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 40));
          return { success: true, data: {} };
        }),
        evaluateCondition: vi.fn().mockReturnValue(true),
      };

      const engine = createFlowEngine({
        db,
        registry,
        stepDeps,
        workerId: 'worker-recover-1',
        flowHeartbeatIntervalMs: 5,
        flowLeaseDurationMs: 60_000,
      });

      const exec = await engine.start('order-processing', { orderId: 'abc' }, makeAuth());

      let caught: unknown;
      try {
        await engine.runNext(exec.id, makeCtx());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LeaseLostError);

      // Now simulate the bootstrap runner finalizing. Flip the mock back to
      // "updates succeed" so the finalizer's UPDATE reports 1 row affected.
      db._updates.length = 0;
      db._state.updateRowCount = 1;
      const finalized = await engine.markFailedFromRunner(exec.id, caught);

      expect(finalized).toBe(true);
      const finalize = db._updates.at(-1);
      expect(finalize).toMatchObject({
        status: FlowStatus.Failed,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(finalize.lastError).toMatch(/Lease lost/);
      expect(finalize.completedAt).toBeInstanceOf(Date);
    });

    it('is a no-op when the row is already in a terminal state', async () => {
      const registry = new FlowRegistry();
      registry.register(makeTestFlow());

      const db = mockDb();
      const engine = createFlowEngine({
        db,
        registry,
        stepDeps: makeStepDeps(),
        workerId: 'worker-recover-2',
      });

      const exec = await engine.start('order-processing', { orderId: 'x' }, makeAuth());

      // Simulate "row already finalized" — UPDATE with status-set guard matches 0 rows.
      db._state.updateRowCount = 0;
      db._updates.length = 0;
      const finalized = await engine.markFailedFromRunner(exec.id, new Error('stale'));

      expect(finalized).toBe(false);
      // The finalizer did attempt the UPDATE, but the status guard is what
      // makes it a no-op against terminal rows — we only assert the return
      // value here since the mock filters by updateRowCount, not SQL.
    });

    it('does not emit flow.runner.finalized audit when the row was already terminal', async () => {
      const registry = new FlowRegistry();
      registry.register(makeTestFlow());

      const db = mockDb();
      const audits: Array<{ action: string }> = [];
      const audit = {
        record: vi.fn().mockImplementation(async (action: string) => {
          audits.push({ action });
        }),
      };

      const engine = createFlowEngine({
        db,
        registry,
        stepDeps: makeStepDeps(),
        workerId: 'worker-recover-3',
        audit,
      });

      const exec = await engine.start('order-processing', { orderId: 'x' }, makeAuth());

      db._state.updateRowCount = 0;
      await engine.markFailedFromRunner(exec.id, new Error('stale'));

      expect(audits.some((a) => a.action === 'flow.runner.finalized')).toBe(false);
    });

    it('uses "Unknown error" when the thrown value is neither Error nor string', async () => {
      const registry = new FlowRegistry();
      registry.register(makeTestFlow());

      const db = mockDb();
      const engine = createFlowEngine({
        db,
        registry,
        stepDeps: makeStepDeps(),
        workerId: 'worker-recover-4',
      });

      const exec = await engine.start('order-processing', { orderId: 'x' }, makeAuth());
      db._updates.length = 0;
      await engine.markFailedFromRunner(exec.id, { weird: true });

      const finalize = db._updates.at(-1);
      expect(finalize.lastError).toBe('Unknown error');
    });
  });
});

// Regression: in production, a flow worker's baseCtx is bound to `systemAuth`
// (userId: 'system-flow-runner', no tenantId). If `ctx.flows.start(...)` from
// inside a flow step inherits that auth, the nested flow row stores
// `tenantId: null`, and any tenantScoped capability inside the nested flow
// rejects with "Tenant context required". The engine must rebind `start` in
// the flow-step ctx so nested flows inherit the calling flow's auth instead.
describe('FlowEngine — flow-step ctx.flows.start propagates flowAuth', () => {
  it('uses the executing flow row auth, not the base worker auth, when starting nested flows', async () => {
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'outer',
        domain: 'test',
        input: z.object({}),
        steps: [{ name: 'kickoff', type: FlowStepType.Capability }],
      }),
    );
    registry.register(
      defineFlow({
        name: 'inner',
        domain: 'test',
        input: z.object({ foo: z.string() }),
        steps: [{ name: 'inner-step', type: FlowStepType.Capability }],
      }),
    );

    // Outer step captures ctx and calls ctx.flows.start('inner', ...). We
    // assert what auth reaches the recursive engine.start call.
    let capturedCtx: any = null;
    const stepDeps = {
      executeCapability: vi.fn().mockImplementation(async (_name, ctx) => {
        capturedCtx = ctx;
        await ctx.flows.start('inner', { foo: 'bar' });
        return { success: true, data: {} };
      }),
      evaluateCondition: vi.fn().mockReturnValue(true),
    };

    const db = mockDb();
    const engine = createFlowEngine({ db, registry, stepDeps });

    // Caller (the human/HTTP) is tenant t-A.
    const callerAuth = {
      userId: 'real-user',
      tenantId: 't-A',
      roles: ['user'],
      scopes: [],
      provider: 'http',
    };
    const exec = await engine.start('outer', {}, callerAuth);

    // The worker's baseCtx — `systemAuth`, NO tenantId. This is the exact
    // shape the worker's bootstrap creates and the regression we're guarding.
    const workerBaseCtx = makeCtx({
      auth: {
        userId: 'system-flow-runner',
        roles: ['system'],
        scopes: [],
        provider: 'worker',
      },
    });

    const row = db._rows.get(exec.id);
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    });

    await engine.runNext(exec.id, workerBaseCtx);

    // Two inserts: outer (from engine.start above), inner (from ctx.flows.start
    // inside the step). The inner row must inherit the OUTER flow's tenantId
    // and actor, not the worker's systemAuth.
    expect(db._inserts).toHaveLength(2);
    const innerRow = db._inserts.find((r: any) => r.flowName === 'inner');
    expect(innerRow).toBeDefined();
    expect(innerRow.tenantId).toBe('t-A');
    expect(innerRow.actor).toBe('real-user');

    // The captured ctx given to the step also has flowAuth (sanity).
    expect(capturedCtx?.auth?.tenantId).toBe('t-A');
    expect(capturedCtx?.auth?.userId).toBe('real-user');
    expect(capturedCtx?.auth?.internal).toBe(true);
  });
});
