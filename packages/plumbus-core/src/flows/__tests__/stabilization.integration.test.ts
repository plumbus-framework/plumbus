import { createWorkerPool } from '../../worker/bootstrap.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { EntityRegistry } from '../../data/registry.js';
import { EventRegistry } from '../../events/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { createInMemoryQueue } from '../../events/queue.js';
import { loadConfig } from '../../config/index.js';
import { buildStepDeps } from '../../runtime/bootstrap.js';
import {
  createJobDispatchService,
  publishPendingJobs,
  jobExecutionsTable,
} from '../../jobs/index.js';
import { replayDeadLetterFlow } from '../dead-letter.js';
import { defineCapability } from '../../define/defineCapability.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { defineFlow } from '../../define/defineFlow.js';
import { LeaseLostError } from '../../errors/index.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import {
  flowExecutionsTable,
  flowSchedulesTable,
  flowScheduleTicksTable,
  flowDeadLetterTable,
} from '../schema.js';
import { createFlowScheduler, computeNextRun } from '../scheduler.js';
import { startPostgres } from './postgres-fixture.js';

let pg: Awaited<ReturnType<typeof startPostgres>>;
beforeAll(async () => {
  pg = await startPostgres();
}, 30000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.reset();
});
const auth = { userId: 'user', tenantId: 'tenant', roles: ['user'], scopes: [], provider: 'test' };
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
function context() {
  return { auth, ai: {}, data: {}, events: {}, flows: {}, logger } as any;
}
function setup(overrides: any = {}, handler: any = async () => ({ success: true, data: {} })) {
  const registry = new FlowRegistry();
  registry.register(
    defineFlow({
      name: 'test',
      domain: 'test',
      input: z.object({}),
      steps: [{ name: 'one', type: 'capability' }],
      ...overrides,
    }),
  );
  const engine = createFlowEngine({
    db: pg.db,
    registry,
    workerId: 'A',
    logger,
    flowHeartbeatIntervalMs: 10000,
    stepDeps: { executeCapability: handler, evaluateCondition: () => true },
  });
  return { registry, engine };
}
function barrier() {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('flow persistence invariants', () => {
  it('cannot overwrite cancellation with an in-flight completion', async () => {
    const entered = barrier();
    const release = barrier();
    const { engine } = setup({}, async () => {
      entered.open();
      await release.wait;
      return { success: true };
    });
    const execution = await engine.start('test', {}, auth);
    const result = engine.runNext(execution.id, context()).catch((error) => error);
    await entered.wait;
    await engine.cancel(execution.id);
    release.open();
    expect(await result).toBeInstanceOf(LeaseLostError);
    expect((await engine.status(execution.id)).status).toBe('cancelled');
  });
  it('fences takeover and same-worker reacquisition, including failure finalizers', async () => {
    const entered = barrier();
    const release = barrier();
    const { engine, registry } = setup({}, async () => {
      entered.open();
      await release.wait;
      return { success: true };
    });
    const other = createFlowEngine({
      db: pg.connect().db,
      registry,
      workerId: 'A',
      stepDeps: {
        executeCapability: async () => ({ success: true }),
        evaluateCondition: () => true,
      },
    });
    const execution = await engine.start('test', {}, auth);
    const claim = await engine.claimExecution(execution.id);
    const result = engine
      .runNext(execution.id, context(), claim?.leaseToken ?? undefined)
      .catch((error) => error);
    await entered.wait;
    await pg.sql`UPDATE flow_executions SET lease_expires_at = now() - interval '1 second' WHERE id = ${execution.id}`;
    const nextClaim = await other.claimExecution(execution.id);
    expect(nextClaim?.leaseToken).not.toBe(claim?.leaseToken);
    expect(
      await engine.markFailedFromRunner(
        execution.id,
        new Error('stale'),
        claim?.leaseToken ?? undefined,
      ),
    ).toBe(false);
    release.open();
    expect(await result).toBeInstanceOf(LeaseLostError);
    expect(
      (await other.runNext(execution.id, context(), nextClaim?.leaseToken ?? undefined)).status,
    ).toBe('completed');
  });
  it('persists retry deadlines and gives each step a fresh budget', async () => {
    const attempts = new Map<string, number>();
    const { engine, registry } = setup(
      {
        steps: [
          { name: 'one', type: 'capability' },
          { name: 'two', type: 'capability' },
        ],
        retry: { maxAttempts: 2, backoff: 'fixed', baseDelayMs: 60 },
      },
      async (name: string) => {
        const attempt = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, attempt);
        return { success: attempt > 1, error: 'transient' };
      },
    );
    const execution = await engine.start('test', {}, auth);
    expect((await engine.runNext(execution.id, context())).status).toBe('waiting');
    expect(await engine.claimExecution(execution.id)).toBeUndefined();
    const restarted = createFlowEngine({
      db: pg.connect().db,
      registry,
      workerId: 'restart',
      stepDeps: {
        executeCapability: async () => ({ success: true }),
        evaluateCondition: () => true,
      },
    });
    expect(await restarted.claimExecution(execution.id)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await engine.runNext(execution.id, context())).status).toBe('running');
    expect((await engine.runNext(execution.id, context())).status).toBe('waiting');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await engine.runNext(execution.id, context())).status).toBe('completed');
    expect(Object.fromEntries(attempts)).toEqual({ one: 2, two: 2 });
  });
  it('does not apply a stale signal to a later activation of the same wait', async () => {
    const { engine } = setup({
      steps: [
        { name: 'wait', type: 'wait', event: 'wake' },
        { name: 'loop', type: 'conditional', if: 'true', then: 'wait', else: 'done' },
        { name: 'done', type: 'capability' },
      ],
    });
    const execution = await engine.start('test', {}, auth);
    await engine.runNext(execution.id, context());
    const [first] = await pg.db.select().from(flowExecutionsTable);
    await engine.resume(execution.id, { first: true });
    await engine.runNext(execution.id, context());
    await engine.runNext(execution.id, context());
    await expect(
      engine.resume(execution.id, { stale: true }, first?.leaseToken),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const [current] = await pg.db.select().from(flowExecutionsTable);
    expect(current?.status).toBe('waiting');
    expect(current?.state).toEqual({ first: true });
  });
  it('records the exhausted attempt and automatic dead-letter snapshot', async () => {
    const { engine } = setup({ retry: { maxAttempts: 1 } }, async () => ({
      success: false,
      error: 'failure',
    }));
    const execution = await engine.start('test', {}, auth);
    expect((await engine.runNext(execution.id, context())).status).toBe('failed');
    const rows = await pg.db.select().from(flowDeadLetterTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.retryCount).toBe(1);
    expect(rows[0]?.stepHistory).toHaveLength(1);
  });
});

describe('durable scheduler', () => {
  it('creates one execution per tick across independent schedulers', async () => {
    const { engine, registry } = setup({ schedule: { cron: 'every:1h' } });
    const first = createFlowScheduler({ db: pg.db, registry, engine, logger });
    const second = createFlowScheduler({ db: pg.connect().db, registry, engine, logger });
    await Promise.all([first.syncSchedules(), second.syncSchedules()]);
    const counts = await Promise.all([first.poll(), second.poll()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await pg.db.select().from(flowExecutionsTable)).toHaveLength(1);
    expect(await pg.db.select().from(flowScheduleTicksTable)).toHaveLength(1);
  });
  it('requires explicit reconciliation to add schedules to an established manifest', async () => {
    const first = setup({ schedule: { cron: 'every:1h' } });
    const active = createFlowScheduler({ db: pg.db, ...first, logger });
    await active.syncSchedules();
    const other = setup({ name: 'late', schedule: { cron: 'every:1h' } });
    const stale = createFlowScheduler({ db: pg.db, ...other, logger });
    expect(await stale.syncSchedules()).toBe(0);
    expect((await pg.db.select().from(flowSchedulesTable)).map((row) => row.flowName)).toEqual([
      'test',
    ]);
    expect((await stale.reconcileSchedules()).changes).toMatchObject([
      { flowName: 'late', action: 'create' },
      { flowName: 'test', action: 'remove' },
    ]);
  });
  it('recovers a committed execution if its wake publication fails', async () => {
    const { engine, registry } = setup({ schedule: { cron: 'every:1h' } });
    const scheduler = createFlowScheduler({
      db: pg.db,
      registry,
      engine: {
        ...engine,
        wake: async () => {
          throw new Error('Redis unavailable');
        },
      },
      logger,
    });
    await scheduler.syncSchedules();
    expect(await scheduler.poll()).toBe(1);
    expect(await scheduler.poll()).toBe(0);
    expect(await engine.claimNext()).toHaveLength(1);
  });
  it('rolls back the tick when execution creation fails', async () => {
    const { engine, registry } = setup({
      schedule: { cron: 'every:1h' },
      input: z.object({ required: z.string() }),
    });
    const scheduler = createFlowScheduler({ db: pg.db, registry, engine, logger });
    await scheduler.syncSchedules();
    expect(await scheduler.poll()).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler failed to start flow "test"',
      expect.objectContaining({ error: expect.stringContaining('invalid input') }),
    );
    expect(await pg.db.select().from(flowScheduleTicksTable)).toHaveLength(0);
    expect(await pg.db.select().from(flowExecutionsTable)).toHaveLength(0);
  });
  it('reconciles changed/removed definitions with revision checks and preserves disabled state', async () => {
    const original = setup({ schedule: { cron: 'every:1h' } });
    const oldScheduler = createFlowScheduler({ db: pg.db, ...original, logger });
    await oldScheduler.syncSchedules();
    await pg.db.update(flowSchedulesTable).set({ enabled: false });
    const changed = setup({ schedule: { cron: 'every:2h' } });
    const next = createFlowScheduler({ db: pg.connect().db, ...changed, logger });
    const preview = await next.reconcileSchedules();
    expect(preview.changes).toMatchObject([
      {
        flowName: 'test',
        action: 'update',
        previous: { cron: 'every:1h' },
        next: { cron: 'every:2h' },
      },
    ]);
    await next.reconcileSchedules({ apply: true, expectedRevision: preview.revision });
    await expect(
      next.reconcileSchedules({ apply: true, expectedRevision: preview.revision }),
    ).rejects.toThrow('revision');
    const [row] = await pg.db.select().from(flowSchedulesTable);
    expect(row).toMatchObject({ cron: 'every:2h', enabled: false });
    const removed = createFlowScheduler({
      db: pg.db,
      engine: original.engine,
      registry: new FlowRegistry(),
      logger,
    });
    const removePreview = await removed.reconcileSchedules();
    await removed.reconcileSchedules({ apply: true, expectedRevision: removePreview.revision });
    await oldScheduler.syncSchedules();
    expect((await pg.db.select().from(flowSchedulesTable))[0]?.removed).toBe(true);
  });
  it('preserves next-first-run and skips overlapping active executions', async () => {
    const { engine, registry } = setup({
      schedule: { cron: 'every:1h', firstRun: 'next', overlap: 'skip' },
    });
    const scheduler = createFlowScheduler({ db: pg.db, engine, registry, logger });
    await scheduler.syncSchedules();
    expect(await scheduler.poll()).toBe(0);
    const [schedule] = await pg.db.select().from(flowSchedulesTable);
    if (!schedule) throw new Error('No schedule');
    await pg.db
      .update(flowSchedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 10000) })
      .where(eq(flowSchedulesTable.id, schedule.id));
    expect(await scheduler.poll()).toBe(1);
    await pg.db
      .update(flowSchedulesTable)
      .set({ nextRunAt: new Date(Date.now() - 5000) })
      .where(eq(flowSchedulesTable.id, schedule.id));
    expect(await scheduler.poll()).toBe(0);
    expect((await pg.db.select().from(flowScheduleTicksTable)).map((row) => row.outcome)).toContain(
      'skipped_overlap',
    );
  });
});

it('rejects invalid cron and uses consistent stepped and weekday semantics', () => {
  expect(() => computeNextRun('not-a-cron', new Date())).toThrow();
  expect(() => computeNextRun('every:0m', new Date())).toThrow();
  expect(
    computeNextRun('5/10 * * * *', new Date('2026-01-01T00:05:00Z'), 'UTC').toISOString(),
  ).toBe('2026-01-01T00:15:00.000Z');
  expect(computeNextRun('0 0 1 * MON', new Date('2026-01-01T00:00:00Z'), 'UTC').toISOString()).toBe(
    '2026-01-05T00:00:00.000Z',
  );
});

describe('durable jobs and replay', () => {
  function jobService(queue: any, identity = auth) {
    const capability = defineCapability({
      name: 'job',
      domain: 'test',
      kind: 'job',
      input: z.object({ value: z.number() }),
      output: z.object({}),
      access: { roles: ['user'], tenantScoped: true },
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({}),
    });
    return createJobDispatchService({
      db: pg.db,
      jobQueue: queue,
      auth: identity,
      source: 'flow',
      resolveCapability: () => capability,
    });
  }
  it('persists a transaction-scoped job before publishing and recovers publication failure', async () => {
    const queue = { publish: vi.fn().mockRejectedValue(new Error('offline')) };
    const jobs = jobService(queue as any);
    const deferred: Array<() => Promise<void>> = [];
    const id = await pg.db.transaction(async (tx) => {
      const bound = jobs.inTransaction?.(tx as any, deferred);
      if (!bound) throw new Error('No transactional dispatcher');
      const id = await bound.enqueue('test.job', { value: 1 });
      expect(queue.publish).not.toHaveBeenCalled();
      return id;
    });
    await deferred[0]?.();
    const [row] = await pg.db.select().from(jobExecutionsTable);
    expect(row).toMatchObject({
      id,
      status: 'queued',
      dispatchPending: true,
      tenantId: 'tenant',
      source: 'flow',
      authSnapshotJson: { userId: 'user' },
    });
    await pg.db.update(jobExecutionsTable).set({ dispatchAfter: new Date(0) });
    queue.publish.mockResolvedValue(undefined);
    await publishPendingJobs(pg.db, queue as any);
    expect((await pg.db.select().from(jobExecutionsTable))[0]?.dispatchPending).toBe(false);
  });
  it('rolls back dispatch intent and prevents unauthorized or conflicting reuse', async () => {
    const queue = { publish: vi.fn(async () => {}) };
    const jobs = jobService(queue as any);
    await expect(
      pg.db.transaction(async (tx) => {
        await jobs.inTransaction?.(tx as any, []).enqueue('test.job', { value: 1 });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await pg.db.select().from(jobExecutionsTable)).toEqual([]);
    expect(queue.publish).not.toHaveBeenCalled();
    const id = await jobs.enqueue('test.job', { value: 1 });
    expect(await jobs.enqueue('test.job', { value: 1 }, { jobId: id })).toBe(id);
    await expect(jobs.enqueue('test.job', { value: 2 }, { jobId: id })).rejects.toThrow(
      'conflicts',
    );
    await expect(
      jobService(queue as any, { ...auth, tenantId: 'other' }).enqueue(
        'test.job',
        { value: 1 },
        { jobId: id },
      ),
    ).rejects.toThrow('conflicts');
    await expect(
      jobService(queue as any, { ...auth, roles: [] }).enqueue('test.job', { value: 1 }),
    ).rejects.toThrow();
  });
  it('compares reusable job IDs using their validated JSON representation', async () => {
    const capability = defineCapability({
      name: 'encoded',
      domain: 'test',
      kind: 'job',
      input: z.object({ when: z.coerce.date(), amount: z.coerce.bigint() }),
      output: z.object({}),
      access: { roles: ['user'] },
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({}),
    });
    const jobs = createJobDispatchService({
      db: pg.db,
      jobQueue: { publish: async () => {} } as any,
      auth,
      resolveCapability: () => capability,
    });
    const id = await jobs.enqueue('test.encoded', { when: '2026-01-01T00:00:00Z', amount: '123' });
    expect(
      await jobs.enqueue(
        'test.encoded',
        { when: new Date('2026-01-01T00:00:00Z'), amount: 123n },
        { jobId: id },
      ),
    ).toBe(id);
    const [row] = await pg.db.select().from(jobExecutionsTable);
    expect(row?.inputJson).toEqual({ when: '2026-01-01T00:00:00.000Z', amount: '123' });
  });
  it('creates one replay across concurrent requests without mutating the terminal source', async () => {
    const { engine, registry } = setup({}, async () => ({ success: false, error: 'failed' }));
    const execution = await engine.start('test', {}, auth);
    await engine.runNext(execution.id, context());
    const ids = await Promise.all(
      [pg.db, pg.connect().db].map((db) => replayDeadLetterFlow(db, registry, execution.id)),
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(execution.id);
    expect((await engine.status(execution.id)).status).toBe('failed');
    const rows = await pg.db.select().from(flowExecutionsTable);
    expect(rows.find((row) => row.id === ids[0])).toMatchObject({
      status: 'created',
      replayOf: execution.id,
      currentStep: 'one',
      actor: 'user',
      tenantId: 'tenant',
    });
  });
});

it('dispatches a job from a real worker flow capability with caller auth and correlation', async () => {
  const job = defineCapability({
    name: 'job',
    domain: 'test',
    kind: 'job',
    input: z.object({ value: z.number() }),
    output: z.object({}),
    access: { roles: ['user'], tenantScoped: true },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({}),
  });
  const startJob = defineCapability({
    name: 'startJob',
    domain: 'test',
    kind: 'action',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    access: { roles: ['user'], tenantScoped: true },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async (ctx) => ({ id: await ctx.jobs.enqueue('test.job', { value: 1 }) }),
  });
  const capabilities = new CapabilityRegistry();
  capabilities.registerAll([job, startJob]);
  const registry = new FlowRegistry();
  registry.register(
    defineFlow({
      name: 'dispatch',
      domain: 'test',
      input: z.object({}),
      steps: [{ name: 'enqueue', type: 'capability', capability: 'test.startJob' }],
    }),
  );
  const queue = createInMemoryQueue();
  const pool = createWorkerPool({
    config: loadConfig({ env: {} }),
    db: pg.db,
    queue,
    jobsQueue: queue,
    capabilities,
    entities: new EntityRegistry(),
    eventRegistry: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: registry,
    stepDeps: buildStepDeps(capabilities),
    logger,
  });
  const execution = await pool.flowEngine.start('dispatch', {}, auth, {
    correlationId: 'flow-correlation',
  });
  expect((await pool.flowEngine.runNext(execution.id, context())).status).toBe('completed');
  const [row] = await pg.db.select().from(jobExecutionsTable);
  expect(row).toMatchObject({
    tenantId: 'tenant',
    authSnapshotJson: { userId: 'user', roles: ['user'] },
    correlationId: 'flow-correlation',
    source: 'flow',
  });
  await queue.close();
});
