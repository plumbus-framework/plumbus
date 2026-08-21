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
import type { LoggerService } from '../../types/context.js';
import type { DataPlaneResolver } from '../../tenancy/types.js';

// ── Mocks ──

const claimNext = vi.fn(async () => [] as Record<string, unknown>[]);
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
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { createOutboxDispatcher } from '../../events/dispatcher.js';
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

  it('reads the tenant from the camel-cased column spelling too', async () => {
    claimNext.mockResolvedValueOnce([{ id: 'exec-a', tenantId: 'tenant-a' }]);

    await runOneCycle(makePoolConfig({ dataPlaneResolver: makeResolver() }), 1);

    expect(runNextDatabases()).toEqual({ 'exec-a': tenantADb });
  });

  it('fails a unit whose tenant the resolver does not recognise, leaving the batch alone', async () => {
    claimNext.mockResolvedValueOnce([
      { id: 'exec-unknown', tenant_id: 'tenant-that-was-never-placed' },
      { id: 'exec-a', tenant_id: 'tenant-a' },
    ]);

    await runOneCycle(makePoolConfig({ dataPlaneResolver: makeResolver() }), 1);

    expect(runNextDatabases()).toEqual({ 'exec-a': tenantADb });
    expect(markFailedFromRunner).toHaveBeenCalledWith('exec-unknown', expect.anything());
  });

  it('refuses untenanted work by default rather than running it on the pool database', async () => {
    claimNext.mockResolvedValueOnce([{ id: 'exec-untenanted', tenant_id: null }]);

    await runOneCycle(makePoolConfig({ dataPlaneResolver: makeResolver() }), 0);

    expect(runNext).not.toHaveBeenCalled();
    expect(markFailedFromRunner).toHaveBeenCalledWith('exec-untenanted', expect.anything());
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
    expect(createEventWorker).toHaveBeenCalledWith(
      expect.objectContaining({ resolver }),
    );
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
