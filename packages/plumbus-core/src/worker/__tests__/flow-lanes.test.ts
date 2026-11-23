// Flow lanes: limits per tenant, per flow and per named lane on the runner slots, slots held
// for untenanted flows, and the fair claim order between tenants. The rules are tested on
// their own; the pool is tested with a mocked engine whose `claimNext` honours the claim
// filter the way the engine's SQL does (oldest eligible first; see claim-filter.pg.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import type { EventQueue } from '../../events/queue.js';
import type { FlowClaimFilter } from '../../flows/engine.js';
import type { FlowLanesConfig, PlumbusConfig } from '../../types/config.js';
import type { LoggerService } from '../../types/context.js';
import { FlowStepType } from '../../types/enums.js';
import { createFlowLaneTracker, type FlowLaneFull, resolveFlowLanes } from '../flow-lanes.js';

interface QueuedRow {
  id: string;
  leaseToken: string;
  flowName: string;
  tenantId: string | null;
}

const engine = vi.hoisted(() => {
  const state = {
    queue: [] as QueuedRow[],
    running: new Set<string>(),
    gates: new Map<string, Array<(status?: string) => void>>(),
    /** Claim filters seen, in order. */
    filters: [] as Array<FlowClaimFilter | undefined>,
    /** When set, the next claim ignores the filter (a hint whose route differs from its row). */
    ignoreFilterOnce: false,
  };
  function eligible(row: QueuedRow, filter: FlowClaimFilter | undefined): boolean {
    if (!filter) return true;
    if (filter.excludeExecutions?.includes(row.id)) return false;
    if (filter.excludeFlows?.includes(row.flowName)) return false;
    if (row.tenantId !== null && filter.excludeTenants?.includes(row.tenantId)) return false;
    if (filter.tenancy === 'untenanted' && row.tenantId !== null) return false;
    if (filter.tenancy === 'tenanted' && row.tenantId === null) return false;
    return true;
  }
  const mock = {
    workerId: 'test-worker-id',
    claimNext: vi.fn(async (_limit: number, filter?: FlowClaimFilter) => {
      state.filters.push(filter);
      const ignore = state.ignoreFilterOnce;
      state.ignoreFilterOnce = false;
      const ordered = filter?.untenantedFirst
        ? [
            ...state.queue.filter((row) => row.tenantId === null),
            ...state.queue.filter((row) => row.tenantId !== null),
          ]
        : state.queue;
      const row = ordered.find((candidate) => ignore || eligible(candidate, filter));
      if (!row) return [];
      state.queue.splice(state.queue.indexOf(row), 1);
      return [row];
    }),
    runNext: vi.fn(
      (executionId: string) =>
        new Promise<{ status: string }>((resolve) => {
          state.running.add(executionId);
          const gates = state.gates.get(executionId) ?? [];
          gates.push((status = 'completed') => {
            state.running.delete(executionId);
            resolve({ status });
          });
          state.gates.set(executionId, gates);
        }),
    ),
    markFailedFromRunner: vi.fn(async () => true),
    acquireExecutionPlane: vi.fn(async () => undefined),
    releaseClaim: vi.fn(async (executionId: string) => {
      // Handed back: claimable again, at its old place.
      const row = released.get(executionId);
      if (row) state.queue.unshift(row);
      return true;
    }),
    start: vi.fn(async () => ({})),
  };
  const released = new Map<string, QueuedRow>();
  return { state, mock, released };
});

vi.mock('../../flows/engine.js', () => ({
  createFlowEngine: vi.fn(() => engine.mock),
  generateWorkerId: vi.fn(() => 'test-worker-id'),
}));

import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { WorkerPool, WorkerPoolConfig } from '../bootstrap.js';
import { createWorkerPool } from '../bootstrap.js';

function flow(name: string, domain: string) {
  return defineFlow({
    name,
    domain,
    input: z.object({}),
    steps: [{ name: 'only', type: FlowStepType.Capability, capability: `${domain}.noop` }],
  });
}

function registry(): FlowRegistry {
  const flows = new FlowRegistry();
  for (const definition of [
    flow('runCourseJudge', 'course-builder'),
    flow('prepareSources', 'course-builder'),
    flow('evaluateSubmission', 'packages'),
    flow('sweepFailedFlows', 'platform'),
    flow('deliverPackageEvents', 'platform'),
  ]) {
    flows.register(definition);
  }
  return flows;
}

function makeConfig(workers?: PlumbusConfig['workers']): PlumbusConfig {
  return {
    environment: 'development',
    database: { host: 'h', port: 1, database: 'd', user: 'u', password: 'p' },
    queue: { host: 'h', port: 1, prefix: 'plumbus:test' },
    auth: { provider: 'jwt', secret: 'test-secret-placeholder-32chars-min' },
    ...(workers ? { workers } : {}),
  };
}

function makeLogger(): LoggerService & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const pools: WorkerPool[] = [];
async function started(overrides: Partial<WorkerPoolConfig> = {}): Promise<WorkerPool> {
  const queue: EventQueue = {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  };
  const pool = createWorkerPool({
    config: makeConfig(),
    db: { execute: vi.fn(async () => undefined) } as never,
    queue,
    consumers: new ConsumerRegistry(),
    flows: registry(),
    stepDeps: { executeCapability: vi.fn(), evaluateCondition: vi.fn(() => true) } as never,
    enableDispatcher: false,
    enableEventWorker: false,
    enableScheduler: false,
    flowPollIntervalMs: 60_000,
    logger: makeLogger(),
    ...overrides,
  });
  pools.push(pool);
  await pool.start();
  return pool;
}

/** Queue executions oldest first: `tenant/flow#n`, or `-/flow#n` for one with no tenant. */
function enqueue(...specs: string[]): void {
  for (const spec of specs) {
    const [tenant, rest] = spec.split('/') as [string, string];
    const [flowName] = rest.split('#') as [string];
    const row = {
      id: spec,
      leaseToken: `token-${spec}`,
      flowName,
      tenantId: tenant === '-' ? null : tenant,
    };
    engine.released.set(spec, row);
    engine.state.queue.push(row);
  }
}

function running(): string[] {
  return [...engine.state.running].sort();
}

function finish(id: string): void {
  const next = engine.state.gates.get(id)?.shift();
  if (!next) throw new Error(`${id} is not running`);
  next();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  engine.state.queue = [];
  engine.state.running.clear();
  engine.state.gates.clear();
  engine.state.filters = [];
  engine.state.ignoreFilterOnce = false;
  engine.released.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    for (const gates of engine.state.gates.values()) for (const open of gates.splice(0)) open();
    await pool.stop({ deadlineAt: Date.now() + 1_000 });
  }
});

const catalog = {
  has: (name: string) => registry().get(name) !== undefined,
  namesInDomain: (domain: string) =>
    registry()
      .getByDomain(domain)
      .map((f) => f.name),
};

describe('resolveFlowLanes', () => {
  it('is off without configuration', () => {
    expect(resolveFlowLanes(undefined, 3, catalog)).toBeUndefined();
  });

  it('defaults to the fair order and no limits once configured', () => {
    expect(resolveFlowLanes({}, 3, catalog)).toEqual({
      slots: 3,
      reservedUntenanted: 0,
      lanes: [],
      tenantOrder: 'fair',
    });
  });

  it('refuses held slots that leave tenant flows none, and out-of-range values', () => {
    expect(() => resolveFlowLanes({ reservedUntenanted: 3 }, 3, catalog)).toThrow(
      /must be less than flowConcurrency/,
    );
    for (const bad of [
      { maxPerTenant: 0 },
      { maxPerFlow: 1.5 },
      { reservedUntenanted: -1 },
      { tenantOrder: 'random' },
      { lanes: { heavy: { max: 0, flows: ['runCourseJudge'] } } },
      { surprise: true },
    ]) {
      expect(() => resolveFlowLanes(bad as FlowLanesConfig, 3, catalog)).toThrow(
        /Invalid workers.flowLanes/,
      );
    }
    expect(() => resolveFlowLanes({ lanes: { empty: { max: 1 } } }, 3, catalog)).toThrow(
      /names no flow and no domain/,
    );
  });

  it('expands domains to their flows and warns about names the worker does not have', () => {
    const warn = vi.fn();
    const lanes = resolveFlowLanes(
      { lanes: { authoring: { max: 1, domains: ['course-builder', 'nowhere'], flows: ['typo'] } } },
      3,
      catalog,
      warn,
    );
    expect([...(lanes?.lanes[0]?.flows ?? [])].sort()).toEqual([
      'prepareSources',
      'runCourseJudge',
      'typo',
    ]);
    expect(warn).toHaveBeenCalledWith('Flow lane names a flow this worker does not have', {
      lane: 'authoring',
      flow: 'typo',
    });
    expect(warn).toHaveBeenCalledWith('Flow lane names a domain with no flow in this worker', {
      lane: 'authoring',
      domain: 'nowhere',
    });
  });
});

describe('flow lane tracker', () => {
  function tracker(config: FlowLanesConfig, slots = 3, onFull?: (full: FlowLaneFull) => void) {
    const lanes = resolveFlowLanes(config, slots, catalog);
    if (!lanes) throw new Error('lanes expected');
    return createFlowLaneTracker(lanes, onFull);
  }

  it('claims only untenanted work once tenant executions fill the slots not held back', () => {
    const lanes = tracker({ reservedUntenanted: 1, tenantOrder: 'fifo' });
    lanes.admit({ executionId: '1', tenant: 'a', flow: 'evaluateSubmission' });
    expect(lanes.claimPlan()).toEqual([{}]);
    lanes.admit({ executionId: '2', tenant: 'b', flow: 'evaluateSubmission' });
    expect(lanes.claimPlan()).toEqual([{ tenancy: 'untenanted' }]);
  });

  it('holds back tenants at maxPerTenant, flows at maxPerFlow and every flow of a full lane', () => {
    const lanes = tracker(
      {
        maxPerTenant: 1,
        maxPerFlow: 2,
        lanes: { authoring: { max: 1, domains: ['course-builder'] } },
        tenantOrder: 'fifo',
      },
      6,
    );
    lanes.admit({ executionId: '1', tenant: 'a', flow: 'runCourseJudge' });
    lanes.admit({ executionId: '2', tenant: 'b', flow: 'evaluateSubmission' });
    lanes.admit({ executionId: '3', tenant: 'c', flow: 'evaluateSubmission' });
    expect(lanes.claimPlan()).toEqual([
      {
        excludeFlows: ['evaluateSubmission', 'prepareSources', 'runCourseJudge'],
        excludeTenants: ['a', 'b', 'c'],
      },
    ]);
  });

  it('plans fair claims: tenants with fewer running first, untenanted first among equals', () => {
    const lanes = tracker({ maxPerTenant: 3 }, 8);
    expect(lanes.claimPlan()).toEqual([{ untenantedFirst: true }]);
    lanes.admit({ executionId: '1', tenant: 'a', flow: 'evaluateSubmission' });
    lanes.admit({ executionId: '2', tenant: 'a', flow: 'evaluateSubmission' });
    lanes.admit({ executionId: '3', tenant: 'b', flow: 'evaluateSubmission' });
    lanes.admit({ executionId: '4', flow: 'sweepFailedFlows' });
    expect(lanes.claimPlan()).toEqual([
      { excludeTenants: ['a', 'b'], untenantedFirst: true, tenancy: 'tenanted' },
      { excludeTenants: ['a'], untenantedFirst: true },
      { untenantedFirst: true },
    ]);
  });

  it('reports a limit when it is reached, again only after it had room, and in the snapshot', () => {
    const onFull = vi.fn();
    const lanes = tracker({ maxPerTenant: 1 }, 3, onFull);
    const first = lanes.admit({ executionId: '1', tenant: 'a', flow: 'evaluateSubmission' });
    expect(onFull).toHaveBeenCalledTimes(1);
    expect(onFull).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'tenant', key: 'a', running: 1, max: 1 }),
    );
    expect(lanes.snapshot()).toMatchObject({
      running: { total: 1, tenanted: 1, untenanted: 0, byTenant: { a: 1 } },
      full: [{ kind: 'tenant', key: 'a', running: 1, max: 1 }],
    });
    lanes.admit({ executionId: '2', tenant: 'b', flow: 'evaluateSubmission' });
    expect(onFull).toHaveBeenCalledTimes(2);
    lanes.release(first);
    expect(lanes.snapshot().full.map((full) => full.key)).toEqual(['b']);
    lanes.admit({ executionId: '3', tenant: 'a', flow: 'evaluateSubmission' });
    expect(onFull).toHaveBeenCalledTimes(3);
  });

  it('marks an execution that breaks a limit it was claimed past', () => {
    const lanes = tracker({ maxPerTenant: 1 });
    lanes.admit({ executionId: '1', tenant: 'a', flow: 'evaluateSubmission' });
    expect(lanes.admit({ executionId: '2', tenant: 'a', flow: 'evaluateSubmission' })).toEqual(
      expect.objectContaining({ exceeded: { kind: 'tenant', key: 'a' } }),
    );
  });
});

describe('worker pool flow lanes', () => {
  it('without lanes, one tenant fills every slot and untenanted flows wait (the old claim)', async () => {
    enqueue(
      'college-a/runCourseJudge#1',
      'college-a/prepareSources#2',
      'college-a/runCourseJudge#3',
      '-/sweepFailedFlows#4',
      'college-b/evaluateSubmission#5',
    );
    const pool = await started({ flowConcurrency: 3 });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(3));
    await settle();
    expect(running()).toEqual([
      'college-a/prepareSources#2',
      'college-a/runCourseJudge#1',
      'college-a/runCourseJudge#3',
    ]);
    expect(pool.flowLanes).toBeUndefined();
    // No filter is passed: the engine claims exactly as before.
    expect(engine.mock.claimNext.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it('holds a slot for untenanted flows and caps one tenant, so spine sweeps and other tenants run', async () => {
    enqueue(
      'college-a/runCourseJudge#1',
      'college-a/prepareSources#2',
      'college-a/runCourseJudge#3',
      '-/sweepFailedFlows#4',
      'college-b/evaluateSubmission#5',
    );
    const pool = await started({
      flowConcurrency: 3,
      flowLanes: { reservedUntenanted: 1, maxPerTenant: 1 },
    });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(3));
    await settle();
    expect(running()).toEqual([
      '-/sweepFailedFlows#4',
      'college-a/runCourseJudge#1',
      'college-b/evaluateSubmission#5',
    ]);
    expect(pool.flowLanes?.running).toMatchObject({ total: 3, tenanted: 2, untenanted: 1 });

    // The sweep ends: college-a is at its limit, so its next execution still waits.
    finish('-/sweepFailedFlows#4');
    await settle();
    expect(running()).not.toContain('college-a/prepareSources#2');
    // college-b ends: a tenant slot is free and college-a has none other running there.
    finish('college-b/evaluateSubmission#5');
    await settle();
    expect(running()).toEqual(['college-a/runCourseJudge#1']);
    finish('college-a/runCourseJudge#1');
    await vi.waitFor(() => expect(running()).toEqual(['college-a/prepareSources#2']));
  });

  it('a named lane keeps heavy authoring flows to their share of the slots', async () => {
    enqueue(
      'college-a/runCourseJudge#1',
      'college-b/prepareSources#2',
      'college-c/runCourseJudge#3',
      'college-a/evaluateSubmission#4',
      'college-b/evaluateSubmission#5',
    );
    await started({
      flowConcurrency: 3,
      config: makeConfig({
        flowLanes: { lanes: { authoring: { max: 1, domains: ['course-builder'] } } },
      }),
    });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(3));
    await settle();
    expect(running()).toEqual([
      'college-a/evaluateSubmission#4',
      'college-a/runCourseJudge#1',
      'college-b/evaluateSubmission#5',
    ]);
    // The lane has room again. College c has nothing running and college b has one, so the
    // fair order takes c's judge run, and the lane keeps b's preparation waiting.
    finish('college-a/runCourseJudge#1');
    await vi.waitFor(() => expect(running()).toContain('college-c/runCourseJudge#3'));
    await settle();
    expect(running()).not.toContain('college-b/prepareSources#2');
  });

  it('serves the tenant with the fewest running first (fair), or the oldest (fifo)', async () => {
    const backlog = [
      'college-a/evaluateSubmission#1',
      'college-a/evaluateSubmission#2',
      'college-a/evaluateSubmission#3',
      'college-b/evaluateSubmission#4',
      'college-c/evaluateSubmission#5',
    ];
    enqueue(...backlog);
    await started({ flowConcurrency: 3, flowLanes: { maxPerTenant: 2 } });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(3));
    await settle();
    expect(running()).toEqual([
      'college-a/evaluateSubmission#1',
      'college-b/evaluateSubmission#4',
      'college-c/evaluateSubmission#5',
    ]);
    for (const pool of pools.splice(0)) {
      for (const gates of engine.state.gates.values()) for (const open of gates.splice(0)) open();
      await pool.stop({ deadlineAt: Date.now() + 1_000 });
    }

    engine.state.queue = [];
    engine.state.running.clear();
    enqueue(...backlog.map((id) => id.replace('#', '#fifo-')));
    await started({ flowConcurrency: 3, flowLanes: { maxPerTenant: 2, tenantOrder: 'fifo' } });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(3));
    await settle();
    expect(running()).toEqual([
      'college-a/evaluateSubmission#fifo-1',
      'college-a/evaluateSubmission#fifo-2',
      'college-b/evaluateSubmission#fifo-4',
    ]);
  });

  it('hands back an execution claimed past its lane and does not claim it again in a loop', async () => {
    enqueue('college-a/evaluateSubmission#1', 'college-a/evaluateSubmission#2');
    const logger = makeLogger();
    await started({
      flowConcurrency: 2,
      flowLanes: { maxPerTenant: 1 },
      logger,
      flowPollIntervalMs: 15,
    });
    await vi.waitFor(() => expect(running()).toEqual(['college-a/evaluateSubmission#1']));
    // The next claim returns an execution its filter excluded: a spine hint whose tenant route
    // differs from its row's tenant.
    engine.state.ignoreFilterOnce = true;
    await vi.waitFor(() =>
      expect(engine.mock.releaseClaim).toHaveBeenCalledWith(
        'college-a/evaluateSubmission#2',
        'token-college-a/evaluateSubmission#2',
      ),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Claimed a flow execution a flow lane holds back; released it',
      expect.objectContaining({ executionId: 'college-a/evaluateSubmission#2', lane: 'tenant' }),
    );
    // Many poll ticks later it has not been claimed again: every claim leaves it out.
    const claimsBefore = engine.mock.claimNext.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const later = engine.mock.claimNext.mock.calls.slice(claimsBefore);
    expect(later.length).toBeGreaterThan(2);
    for (const [, filter] of later) {
      expect(filter?.excludeExecutions).toEqual(['college-a/evaluateSubmission#2']);
    }
    expect(engine.mock.releaseClaim).toHaveBeenCalledTimes(1);
    expect(engine.mock.runNext).not.toHaveBeenCalledWith(
      'college-a/evaluateSubmission#2',
      expect.anything(),
      expect.anything(),
    );
    // Its tenant's running execution ends: it is claimed and runs.
    finish('college-a/evaluateSubmission#1');
    await vi.waitFor(() => expect(running()).toEqual(['college-a/evaluateSubmission#2']));
  });

  it('logs a reached limit once and reports it in pool.flowLanes', async () => {
    enqueue('college-a/evaluateSubmission#1', 'college-a/evaluateSubmission#2');
    const logger = makeLogger();
    const pool = await started({ flowConcurrency: 2, flowLanes: { maxPerTenant: 1 }, logger });
    await vi.waitFor(() => expect(running()).toEqual(['college-a/evaluateSubmission#1']));
    await settle();
    expect(running()).toEqual(['college-a/evaluateSubmission#1']);
    expect(logger.info).toHaveBeenCalledWith(
      'Flow lane full: the executions it covers wait, runnable, until one of its running executions ends',
      { lane: 'tenant', key: 'college-a', running: 1, max: 1 },
    );
    expect(pool.flowLanes?.full).toEqual([
      expect.objectContaining({ kind: 'tenant', key: 'college-a', running: 1, max: 1 }),
    ]);
    expect(logger.info).toHaveBeenCalledWith('Flow lanes on', expect.objectContaining({}));
  });

  it('refuses invalid lanes when the pool is built', () => {
    expect(() =>
      createWorkerPool({
        config: makeConfig({ flowConcurrency: 2, flowLanes: { reservedUntenanted: 2 } }),
        db: { execute: vi.fn(async () => undefined) } as never,
        queue: {
          publish: vi.fn(async () => {}),
          subscribe: vi.fn(() => () => {}),
          close: vi.fn(async () => {}),
        },
        consumers: new ConsumerRegistry(),
        flows: registry(),
        stepDeps: { executeCapability: vi.fn(), evaluateCondition: vi.fn(() => true) } as never,
        enableDispatcher: false,
        enableEventWorker: false,
        enableScheduler: false,
        logger: makeLogger(),
      }),
    ).toThrow(/reservedUntenanted/);
  });
});
