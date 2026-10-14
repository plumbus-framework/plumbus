// ── Per-unit data-plane routing in the worker pool ──
//
// The flow runner claims work from the pool's own database and then runs each
// claimed execution against the data plane its tenant resolves to. These tests
// pin both halves of that: the default path still hands every unit the pool's
// database, and the resolver path hands each unit its own — refusing, rather
// than guessing, when a unit carries no tenant.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { EventQueue } from '../../events/queue.js';
import type { StepExecutorDeps } from '../../flows/step-executor.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { ExecutionContext, LoggerService } from '../../types/context.js';
import type { DataPlaneResolver } from '../../tenancy/types.js';

// ── Mocks ──

const claimNext = vi.fn(async (_limit?: number) => [] as Record<string, unknown>[]);
const runNext = vi.fn(async (_id: string, _ctx: unknown) => ({ status: 'completed' }));
const markFailedFromRunner = vi.fn(async () => {});

vi.mock('../../flows/engine.js', () => ({
  createFlowEngine: vi.fn(() => ({
    claimNext,
    runNext,
    markFailedFromRunner,
    workerId: 'test-worker-id',
  })),
  generateWorkerId: vi.fn(() => 'test-worker-id'),
}));

const createFlowStepConsumer = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('../../flows/step-consumer.js', () => ({
  createFlowStepConsumer: (...args: unknown[]) => createFlowStepConsumer(...(args as [])),
}));

vi.mock('../../flows/scheduler.js', () => ({
  createFlowScheduler: vi.fn(() => ({
    syncSchedules: vi.fn(async () => 0),
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: false,
  })),
}));

vi.mock('../../events/dispatcher.js', () => ({
  createOutboxDispatcher: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), isRunning: false })),
}));

vi.mock('../../events/worker.js', () => ({
  createEventWorker: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), isRunning: false })),
}));

vi.mock('../../events/idempotency.js', () => ({
  createIdempotencyService: vi.fn(() => ({
    check: vi.fn(async () => false),
    record: vi.fn(async () => {}),
  })),
}));

// The context the runner builds is opaque from the outside, so stand in for the
// wiring step and hand back the database it was asked to wire against. That is
// the fact under test: which database a unit of work ended up on.
vi.mock('../../execution/context-deps.js', () => ({
  wireContextDependencies: vi.fn((options: { db: PostgresJsDatabase }) => ({
    auth: { roles: [], scopes: [], provider: 'worker' },
    wiredAgainst: options.db,
  })),
}));

vi.mock('../../execution/context-factory.js', () => ({
  createExecutionContext: vi.fn((deps: unknown) => deps),
}));

import { EntityRegistry } from '../../data/registry.js';
import { wireContextDependencies } from '../../execution/context-deps.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { createOutboxDispatcher } from '../../events/dispatcher.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { createFlowEngine } from '../../flows/engine.js';
import { createEventWorker } from '../../events/worker.js';
import { EventRegistry } from '../../events/registry.js';
import { createFlowScheduler } from '../../flows/scheduler.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { WorkerPoolConfig } from '../bootstrap.js';
import { createWorkerPool } from '../bootstrap.js';

// ── Helpers ──

/** Distinguishable database handles; identity is what the assertions compare. */
function makeDb(name: string): PostgresJsDatabase {
  return { name, execute: vi.fn(async () => undefined) } as unknown as PostgresJsDatabase;
}

const poolDb = makeDb('pool');
const tenantADb = makeDb('tenant-a');
const tenantBDb = makeDb('tenant-b');

const placements = new Map<string, PostgresJsDatabase>([
  ['tenant-a', tenantADb],
  ['tenant-b', tenantBDb],
]);

function makeResolver(): DataPlaneResolver {
  return {
    resolve: async (tenantRef: string) => {
      const db = placements.get(tenantRef);
      if (!db) throw new Error(`No data plane for "${tenantRef}"`);
      return { db, coreSchema: 'public', packageSchemaPrefix: 'pkg_', tenantRef };
    },
  };
}

const silentLogger: LoggerService = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeConfig(): PlumbusConfig {
  return {
    environment: 'development',
    database: {
      host: 'localhost',
      port: 5432,
      database: 'plumbus_dev',
      user: 'postgres',
      password: 'postgres',
    },
    queue: { host: 'localhost', port: 6379, prefix: 'plumbus:dev' },
    auth: { provider: 'jwt', secret: 'a-test-secret-of-at-least-32-characters' },
  };
}

function makeQueue(): EventQueue {
  return {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  };
}

function makeStepDeps(): StepExecutorDeps {
  return {
    executeCapability: vi.fn(async () => ({ success: true, data: {} })),
    evaluateCondition: vi.fn(() => true),
  };
}

function makePoolConfig(overrides?: Partial<WorkerPoolConfig>): WorkerPoolConfig {
  return {
    config: makeConfig(),
    db: poolDb,
    queue: makeQueue(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    stepDeps: makeStepDeps(),
    // Both registries present, so the runner takes the wired-dependencies
    // branch — the one a real deployment uses.
    entities: new EntityRegistry(),
    eventRegistry: new EventRegistry(),
    logger: silentLogger,
    // One immediate cycle is enough; keep the timer from firing a second one.
    flowPollIntervalMs: 3_600_000,
    enableScheduler: false,
    enableDispatcher: false,
    enableEventWorker: false,
    ...overrides,
  };
}

/** The database each `runNext` call was handed, keyed by execution id. */
function runNextDatabases(): Record<string, unknown> {
  const seen: Record<string, unknown> = {};
  for (const [id, ctx] of runNext.mock.calls) {
    seen[id] = (ctx as { wiredAgainst?: unknown }).wiredAgainst;
  }
  return seen;
}

async function runOneCycle(config: WorkerPoolConfig, expectedRuns: number): Promise<void> {
  const pool = createWorkerPool(config);
  await pool.start();
  if (expectedRuns > 0) {
    await vi.waitFor(() => expect(runNext).toHaveBeenCalledTimes(expectedRuns));
  } else {
    await vi.waitFor(() => expect(claimNext).toHaveBeenCalled());
  }
  await pool.stop();
}

// ── Tests ──

describe('worker per-unit data-plane routing', () => {
  it('does not preclaim waiting work or overlap poll cycles while a step is blocked', async () => {
    vi.useFakeTimers();
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    claimNext.mockResolvedValueOnce([{ id: 'slow', tenantId: 'tenant-a' }]);
    claimNext.mockResolvedValueOnce([{ id: 'next', tenantId: 'tenant-a' }]);
    runNext.mockImplementationOnce(async () => {
      await blocked;
      return { status: 'completed' };
    });
    const pool = createWorkerPool(
      makePoolConfig({ flowPollIntervalMs: 10, flowLeaseDurationMs: 30 }),
    );
    try {
      await pool.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(claimNext).toHaveBeenCalledTimes(1);
      expect(claimNext).toHaveBeenCalledWith(1);
      expect(runNext).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(runNext.mock.calls.map(([id]) => id)).toEqual(['slow', 'next']);
      expect(claimNext.mock.calls.every((args) => args[0] === 1)).toBe(true);
    } finally {
      release();
      await pool.stop();
      vi.useRealTimers();
    }
  });

  it('does not claim the next flow after shutdown while the current step finishes', async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    claimNext.mockResolvedValueOnce([{ id: 'slow', tenantId: 'tenant-a' }]);
    runNext.mockImplementationOnce(async () => {
      await blocked;
      return { status: 'completed' };
    });
    const pool = createWorkerPool(makePoolConfig());
    await pool.start();
    await vi.waitFor(() => expect(runNext).toHaveBeenCalledTimes(1));
    await pool.stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(claimNext).toHaveBeenCalledTimes(1);
  });

  it('waits in stop() for a claim query in flight, so the host can close the database after', async () => {
    let finishClaim = (_rows: Record<string, unknown>[]) => {};
    claimNext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishClaim = resolve;
        }),
    );
    const pool = createWorkerPool(makePoolConfig());
    await pool.start();
    await vi.waitFor(() => expect(claimNext).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = pool.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    finishClaim([]);
    await stopping;
    expect(claimNext).toHaveBeenCalledTimes(1);
  });

  it('keeps claiming while a tenant plane of the dead-letter sweep does not answer, and stop() waits for that plane only', async () => {
    let answerPlane = (_error: Error) => {};
    const resolvedRefs: string[] = [];
    const resolver: DataPlaneResolver = {
      resolve: async (tenantRef: string) => {
        resolvedRefs.push(tenantRef);
        if (tenantRef === 'tenant-down') {
          // An unreachable plane: the connection attempt hangs until its connect timeout.
          await new Promise<never>((_resolve, reject) => {
            answerPlane = reject;
          });
        }
        return makeResolver().resolve(tenantRef);
      },
    };
    const pool = createWorkerPool(
      makePoolConfig({
        dataPlaneResolver: resolver,
        listTenantRefs: () => ['tenant-down', 'tenant-a'],
      }),
    );
    await pool.start();
    await vi.waitFor(() => expect(resolvedRefs).toEqual(['tenant-down']));
    // The claim cycle did not wait for the sweep.
    await vi.waitFor(() => expect(claimNext).toHaveBeenCalled());

    let stopped = false;
    const stopping = pool.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    answerPlane(new Error('CONNECT_TIMEOUT'));
    await stopping;
    // The sweep ended at the next plane once the pool stopped.
    expect(resolvedRefs).toEqual(['tenant-down']);
  });

  it('starts no tenant dead-letter sweep once stop() has begun, even when the pool sweep ends after it', async () => {
    let finishPoolSweep = (_rows: unknown[]) => {};
    // The pool sweep's SELECT (select().from().where().limit()) stays open until released.
    const sweepingPoolDb = {
      name: 'pool',
      execute: vi.fn(async () => undefined),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              new Promise<unknown[]>((resolve) => {
                finishPoolSweep = resolve;
              }),
          }),
        }),
      }),
    } as unknown as PostgresJsDatabase;
    const listTenantRefs = vi.fn(() => ['tenant-a']);
    const pool = createWorkerPool(
      makePoolConfig({ db: sweepingPoolDb, dataPlaneResolver: makeResolver(), listTenantRefs }),
    );
    await pool.start();
    // First cycle: the pool sweep is in flight and a tenant sweep is due right after it.
    expect(listTenantRefs).not.toHaveBeenCalled();

    const stopping = pool.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishPoolSweep([]);
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing reaches the host's tenant list (or any plane) after stop() returned.
    expect(listTenantRefs).not.toHaveBeenCalled();
    expect(silentLogger.warn).not.toHaveBeenCalledWith(
      'Flow dead-letter sweep failed',
      expect.anything(),
    );
  });

  it('rate-limits dead-letter sweep warnings per source, so a failing pool or plane hides no other', async () => {
    // The pool db has no select(), so the pool sweep fails; neither listed tenant resolves.
    const pool = createWorkerPool(
      makePoolConfig({
        dataPlaneResolver: makeResolver(),
        listTenantRefs: () => ['tenant-gone', 'tenant-lost'],
      }),
    );
    await pool.start();
    const sweepWarnings = () =>
      vi
        .mocked(silentLogger.warn)
        .mock.calls.filter(([message]) => message === 'Flow dead-letter sweep failed')
        .map(([, meta]) => {
          const { source, tenantRef } = meta as { source?: string; tenantRef?: string };
          return tenantRef ? `${source}:${tenantRef}` : source;
        });
    await vi.waitFor(() => expect(sweepWarnings()).toHaveLength(3));
    await pool.stop();
    expect(sweepWarnings()).toEqual([
      'pool',
      'tenant-plane:tenant-gone',
      'tenant-plane:tenant-lost',
    ]);
  });

  it('names a tenant-list failure as such, apart from a pool sweep failure', async () => {
    const pool = createWorkerPool(
      makePoolConfig({
        dataPlaneResolver: makeResolver(),
        listTenantRefs: () => {
          throw new Error('control plane unreachable');
        },
      }),
    );
    await pool.start();
    const sweepWarnings = () =>
      vi
        .mocked(silentLogger.warn)
        .mock.calls.filter(([message]) => message === 'Flow dead-letter sweep failed')
        .map(([, meta]) => meta as { source?: string; error?: string });
    await vi.waitFor(() => expect(sweepWarnings()).toHaveLength(2));
    await pool.stop();
    expect(sweepWarnings()).toEqual([
      expect.objectContaining({ source: 'pool' }),
      expect.objectContaining({ source: 'tenant-list', error: 'control plane unreachable' }),
    ]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    claimNext.mockResolvedValue([]);
  });

  it('runs every claimed unit against the pool database when no resolver is configured', async () => {
    claimNext.mockResolvedValueOnce([
      { id: 'exec-a', tenant_id: 'tenant-a' },
      { id: 'exec-b', tenant_id: 'tenant-b' },
    ]);

    await runOneCycle(makePoolConfig(), 2);

    expect(runNextDatabases()).toEqual({ 'exec-a': poolDb, 'exec-b': poolDb });
    expect(markFailedFromRunner).not.toHaveBeenCalled();
  });

  it('runs each claimed unit against its own tenant data plane', async () => {
    claimNext.mockResolvedValueOnce([
      { id: 'exec-a', tenant_id: 'tenant-a' },
      { id: 'exec-b', tenant_id: 'tenant-b' },
    ]);

    await runOneCycle(makePoolConfig({ dataPlaneResolver: makeResolver() }), 2);

    expect(runNextDatabases()).toEqual({ 'exec-a': tenantADb, 'exec-b': tenantBDb });
    expect(markFailedFromRunner).not.toHaveBeenCalled();
  });

  it.each([
    'resolved',
    'control-plane',
  ] as const)('reports failed flow capabilities against their %s unit database', async (unitDataPlane) => {
    claimNext.mockResolvedValueOnce([{ id: 'exec-a', tenant_id: 'tenant-a' }]);
    const onCapabilityError = vi.fn();
    const stepDeps: StepExecutorDeps = {
      ...makeStepDeps(),
      executeCapability: async () => ({
        success: false,
        error: { code: 'conflict', message: 'Already running' },
        capability: { domain: 'reports', name: 'startReport' },
      }),
    };
    runNext.mockImplementationOnce(async (_id, ctx) => {
      const wiredStepDeps = vi.mocked(createFlowEngine).mock.calls[0]?.[0].stepDeps;
      await wiredStepDeps?.executeCapability(
        'reports.startReport',
        {
          ...(ctx as ExecutionContext),
          auth: {
            userId: 'u1',
            tenantId: 'tenant-a',
            roles: ['admin'],
            scopes: [],
            provider: 'test',
          },
        },
        {},
      );
      return { status: 'completed' };
    });

    await runOneCycle(
      makePoolConfig({
        dataPlaneResolver: makeResolver(),
        unitDataPlane,
        stepDeps,
        onCapabilityError,
      }),
      1,
    );

    expect(onCapabilityError).toHaveBeenCalledTimes(1);
    expect(onCapabilityError).toHaveBeenCalledWith(
      expect.objectContaining({
        db: unitDataPlane === 'resolved' ? tenantADb : poolDb,
        tenantId: 'tenant-a',
        source: 'flow',
      }),
    );
    expect(markFailedFromRunner).not.toHaveBeenCalled();
  });

  it('wires a tenant unit’s context with the row’s tenant on its auth, and an untenanted one without', async () => {
    claimNext.mockResolvedValueOnce([
      { id: 'exec-a', tenant_id: 'tenant-a' },
      { id: 'exec-untenanted', tenant_id: null },
    ]);

    await runOneCycle(
      makePoolConfig({ dataPlaneResolver: makeResolver(), untenantedDataPlane: 'control-plane' }),
      2,
    );

    const wired = vi
      .mocked(wireContextDependencies)
      .mock.calls.map(([options]) => options as { auth: { tenantId?: string }; db: unknown });
    expect(wired.map((options) => [options.auth.tenantId, options.db])).toEqual([
      ['tenant-a', tenantADb],
      [undefined, poolDb],
    ]);
  });

  it('keeps a tenant unit’s repositories on the pool database under unitDataPlane control-plane, with the tenant still on its auth', async () => {
    claimNext.mockResolvedValueOnce([
      { id: 'exec-a', tenant_id: 'tenant-a' },
      { id: 'exec-untenanted', tenant_id: null },
    ]);

    await runOneCycle(
      makePoolConfig({
        dataPlaneResolver: makeResolver(),
        untenantedDataPlane: 'control-plane',
        unitDataPlane: 'control-plane',
      }),
      2,
    );

    const wired = vi
      .mocked(wireContextDependencies)
      .mock.calls.map(
        ([options]) =>
          options as { auth: { tenantId?: string }; db: unknown; durableDispatch?: unknown },
      );
    expect(
      wired.map((options) => [options.auth.tenantId, options.db, options.durableDispatch]),
    ).toEqual([
      ['tenant-a', poolDb, undefined],
      [undefined, poolDb, undefined],
    ]);
    expect(runNextDatabases()).toEqual({ 'exec-a': poolDb, 'exec-untenanted': poolDb });
  });

  // Job publication, recovery and the job consumer read the pool, so only a unit that runs on the
  // pool's database may enqueue jobs; a unit on a resolved tenant plane gets the throwing default.
  it.each([
    ['no resolver', {}, [true, true]],
    [
      'unitDataPlane control-plane',
      { unitDataPlane: 'control-plane' as const, dataPlaneResolver: makeResolver() },
      [true, true],
    ],
    ['resolved unit planes', { dataPlaneResolver: makeResolver() }, [false, true]],
  ])('wires a flow unit’s job queue only on the pool database (%s)', async (_name, overrides, expected) => {
    claimNext.mockResolvedValueOnce([
      { id: 'exec-a', tenant_id: 'tenant-a' },
      { id: 'exec-untenanted', tenant_id: null },
    ]);

    await runOneCycle(
      makePoolConfig({
        capabilities: new CapabilityRegistry(),
        untenantedDataPlane: 'control-plane',
        ...overrides,
      }),
      2,
    );

    const jobs = vi
      .mocked(wireContextDependencies)
      .mock.calls.map((call) => (call as unknown[])[1] as { jobs?: unknown });
    expect(jobs.map((extras) => extras.jobs !== undefined)).toEqual(
      // Without a resolver both rows share one context, built once.
      'dataPlaneResolver' in overrides ? expected : [expected[0]],
    );
  });

  it('reads the tenant from the camel-cased column spelling too', async () => {
    claimNext.mockResolvedValueOnce([{ id: 'exec-a', tenantId: 'tenant-a' }]);

    await runOneCycle(makePoolConfig({ dataPlaneResolver: makeResolver() }), 1);

    expect(runNextDatabases()).toEqual({ 'exec-a': tenantADb });
  });

  it('fails a unit whose tenant the resolver does not recognise, leaving the batch alone', async () => {
    claimNext.mockResolvedValueOnce([
      {
        id: 'exec-unknown',
        tenant_id: 'tenant-that-was-never-placed',
        leaseToken: 'lease-unknown',
      },
      { id: 'exec-a', tenant_id: 'tenant-a' },
    ]);

    await runOneCycle(makePoolConfig({ dataPlaneResolver: makeResolver() }), 1);

    expect(runNextDatabases()).toEqual({ 'exec-a': tenantADb });
    expect(markFailedFromRunner).toHaveBeenCalledWith(
      'exec-unknown',
      expect.anything(),
      'lease-unknown',
    );
  });

  it('refuses untenanted work by default rather than running it on the pool database', async () => {
    claimNext.mockResolvedValueOnce([
      { id: 'exec-untenanted', tenant_id: null, leaseToken: 'lease-untenanted' },
    ]);

    await runOneCycle(makePoolConfig({ dataPlaneResolver: makeResolver() }), 0);

    expect(runNext).not.toHaveBeenCalled();
    expect(markFailedFromRunner).toHaveBeenCalledWith(
      'exec-untenanted',
      expect.anything(),
      'lease-untenanted',
    );
  });

  it('runs untenanted work on the pool database when configured to', async () => {
    claimNext.mockResolvedValueOnce([{ id: 'exec-untenanted', tenant_id: null }]);

    await runOneCycle(
      makePoolConfig({
        dataPlaneResolver: makeResolver(),
        untenantedDataPlane: 'control-plane',
      }),
      1,
    );

    expect(runNextDatabases()).toEqual({ 'exec-untenanted': poolDb });
    expect(markFailedFromRunner).not.toHaveBeenCalled();
  });

  it('builds the engine with spine dispatch carrying the untenanted policy, so control-plane rows are claimed beside the hints', () => {
    const resolver = makeResolver();
    createWorkerPool(
      makePoolConfig({ dataPlaneResolver: resolver, untenantedDataPlane: 'control-plane' }),
    );
    // The durable schema rides on the dispatch descriptor: the host's name, else the
    // framework default — the same resolution the outbox pump reads with.
    expect(createFlowEngine).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spineDispatch: {
          db: poolDb,
          resolver,
          untenanted: 'control-plane',
          coreSchema: 'core_plumbus',
        },
      }),
    );
    createWorkerPool(makePoolConfig({ dataPlaneResolver: resolver }));
    expect(createFlowEngine).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spineDispatch: { db: poolDb, resolver, untenanted: 'refuse', coreSchema: 'core_plumbus' },
      }),
    );
    createWorkerPool(
      makePoolConfig({ dataPlaneResolver: resolver, frameworkSchema: 'core_named' }),
    );
    expect(createFlowEngine).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spineDispatch: { db: poolDb, resolver, untenanted: 'refuse', coreSchema: 'core_named' },
      }),
    );
    createWorkerPool(makePoolConfig({}));
    expect(createFlowEngine).toHaveBeenLastCalledWith(
      expect.objectContaining({ spineDispatch: undefined }),
    );
  });

  it('points the outbox dispatcher at the resolver and spine db', () => {
    const resolver = makeResolver();
    createWorkerPool(
      makePoolConfig({
        dataPlaneResolver: resolver,
        listTenantRefs: async () => ['tenant-a'],
        enableDispatcher: true,
      }),
    );
    expect(createOutboxDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        resolver,
        spineDb: poolDb,
        listTenantRefs: expect.any(Function),
      }),
    );
    // The host's durable schema reaches the pump exactly as it reaches the engine.
    createWorkerPool(
      makePoolConfig({
        dataPlaneResolver: resolver,
        listTenantRefs: async () => ['tenant-a'],
        enableDispatcher: true,
        frameworkSchema: 'core_named',
      }),
    );
    expect(createOutboxDispatcher).toHaveBeenLastCalledWith(
      expect.objectContaining({ resolver, spineDb: poolDb, frameworkSchema: 'core_named' }),
    );
  });

  it('points the event worker and scheduler at the resolver', () => {
    const resolver = makeResolver();
    createWorkerPool(
      makePoolConfig({
        dataPlaneResolver: resolver,
        listTenantRefs: async () => ['tenant-a'],
        enableEventWorker: true,
        enableScheduler: true,
      }),
    );
    expect(createEventWorker).toHaveBeenCalledWith(expect.objectContaining({ resolver }));
    expect(createFlowScheduler).toHaveBeenCalledWith(
      expect.objectContaining({
        resolver,
        listTenantRefs: expect.any(Function),
      }),
    );
  });

  it('does not start the queue-driven step consumer when a resolver is configured', () => {
    createWorkerPool(makePoolConfig());
    expect(createFlowStepConsumer).toHaveBeenCalledTimes(1);

    createFlowStepConsumer.mockClear();
    createWorkerPool(makePoolConfig({ dataPlaneResolver: makeResolver() }));
    expect(createFlowStepConsumer).not.toHaveBeenCalled();
  });

  it('refuses a caller-built data service alongside a resolver', () => {
    expect(() =>
      createWorkerPool(
        makePoolConfig({
          dataPlaneResolver: makeResolver(),
          createDataService: () => ({}) as never,
        }),
      ),
    ).toThrow(/createDataService/);
  });
});
