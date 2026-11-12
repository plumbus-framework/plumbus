// Flow runner concurrency: each runner slot claims one execution and drains it on its own, so a
// long flow holds one slot while the others keep claiming. The engine is mocked: `claimNext`
// hands out queued rows and every `runNext` waits on a gate the test opens.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventQueue } from '../../events/queue.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { LoggerService } from '../../types/context.js';

interface Row {
  id: string;
  leaseToken: string;
}

interface Gate {
  open(status?: string): void;
  fail(error: Error): void;
}

const engine = vi.hoisted(() => {
  const state = {
    queue: [] as Array<{ id: string; leaseToken: string }>,
    running: new Set<string>(),
    maxRunning: 0,
    gates: new Map<string, Array<{ open(status?: string): void; fail(error: Error): void }>>(),
    order: [] as string[],
  };
  const mock = {
    workerId: 'test-worker-id',
    claimNext: vi.fn(async (_limit: number) => {
      const row = state.queue.shift();
      return row ? [row] : [];
    }),
    runNext: vi.fn(
      (executionId: string, _ctx: unknown, _leaseToken?: string) =>
        new Promise<{ status: string }>((resolve, reject) => {
          state.running.add(executionId);
          state.maxRunning = Math.max(state.maxRunning, state.running.size);
          state.order.push(`start:${executionId}`);
          const gate = {
            open(status = 'completed') {
              state.running.delete(executionId);
              state.order.push(`end:${executionId}`);
              resolve({ status });
            },
            fail(error: Error) {
              state.running.delete(executionId);
              state.order.push(`fail:${executionId}`);
              reject(error);
            },
          };
          const gates = state.gates.get(executionId) ?? [];
          gates.push(gate);
          state.gates.set(executionId, gates);
        }),
    ),
    markFailedFromRunner: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => true),
    start: vi.fn(async () => ({})),
  };
  return { state, mock };
});

vi.mock('../../flows/engine.js', () => ({
  createFlowEngine: vi.fn(() => engine.mock),
  generateWorkerId: vi.fn(() => 'test-worker-id'),
}));

import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { WorkerPool, WorkerPoolConfig } from '../bootstrap.js';
import { createWorkerPool, DEFAULT_FLOW_CONCURRENCY } from '../bootstrap.js';

function makeConfig(workers?: PlumbusConfig['workers']): PlumbusConfig {
  return {
    environment: 'development',
    database: { host: 'h', port: 1, database: 'd', user: 'u', password: 'p' },
    queue: { host: 'h', port: 1, prefix: 'plumbus:test' },
    auth: { provider: 'jwt', secret: 'test-secret-placeholder-32chars-min' },
    ...(workers ? { workers } : {}),
  };
}

function makeLogger(): LoggerService & { info: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makePool(overrides: Partial<WorkerPoolConfig> = {}): WorkerPool {
  const queue: EventQueue = {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  };
  return createWorkerPool({
    config: makeConfig(),
    // Answers the lease-column preflight; the dead-letter and deferred-start sweeps fail on
    // this stub and are logged, which the runner tolerates.
    db: { execute: vi.fn(async () => undefined) } as never,
    queue,
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    stepDeps: { executeCapability: vi.fn(), evaluateCondition: vi.fn(() => true) } as never,
    enableDispatcher: false,
    enableEventWorker: false,
    enableScheduler: false,
    // One tick at start only: everything after it has to come from the slots themselves.
    flowPollIntervalMs: 60_000,
    logger: makeLogger(),
    ...overrides,
  });
}

function enqueue(...ids: string[]): Row[] {
  const rows = ids.map((id) => ({ id, leaseToken: `token-${id}` }));
  engine.state.queue.push(...rows);
  return rows;
}

function gate(id: string): Gate {
  const gates = engine.state.gates.get(id);
  const next = gates?.shift();
  if (!next) throw new Error(`no step of ${id} is running`);
  return next;
}

function isRunning(id: string): boolean {
  return engine.state.running.has(id);
}

const pools: WorkerPool[] = [];
async function started(overrides: Partial<WorkerPoolConfig> = {}): Promise<WorkerPool> {
  const pool = makePool(overrides);
  pools.push(pool);
  await pool.start();
  return pool;
}

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    // Open whatever is still waiting so the test's slots end.
    for (const gates of engine.state.gates.values()) for (const g of gates.splice(0)) g.open();
    await pool.stop({ deadlineAt: Date.now() + 1_000 });
  }
});

beforeEach(() => {
  engine.state.queue = [];
  engine.state.running.clear();
  engine.state.gates.clear();
  engine.state.order = [];
  engine.state.maxRunning = 0;
  vi.clearAllMocks();
});

describe('flow runner concurrency', () => {
  it('defaults to one execution at a time', async () => {
    expect(DEFAULT_FLOW_CONCURRENCY).toBe(1);
    enqueue('long', 'short');
    await started();

    await vi.waitFor(() => expect(isRunning('long')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(isRunning('short')).toBe(false);

    gate('long').open();
    // The slot claims the next execution at once, not at the next poll.
    await vi.waitFor(() => expect(isRunning('short')).toBe(true));
    gate('short').open();
    await vi.waitFor(() => expect(engine.state.order).toContain('end:short'));
    expect(engine.state.maxRunning).toBe(1);
  });

  it('completes a short flow while a long one is still running', async () => {
    enqueue('long', 'short');
    await started({ flowConcurrency: 2 });

    await vi.waitFor(() => {
      expect(isRunning('long')).toBe(true);
      expect(isRunning('short')).toBe(true);
    });
    gate('short').open();
    await vi.waitFor(() => expect(engine.state.order).toContain('end:short'));
    expect(isRunning('long')).toBe(true);
    expect(engine.state.order).not.toContain('end:long');
    gate('long').open();
    await vi.waitFor(() => expect(engine.state.order).toContain('end:long'));
  });

  it('runs at most flowConcurrency executions, and a freed slot claims the next at once', async () => {
    enqueue('a', 'b', 'c', 'd');
    await started({ flowConcurrency: 3 });

    await vi.waitFor(() => expect(engine.state.running.size).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engine.state.running.size).toBe(3);
    expect(isRunning('d')).toBe(false);

    gate('b').open();
    await vi.waitFor(() => expect(isRunning('d')).toBe(true));
    expect(engine.state.running.size).toBe(3);

    for (const id of ['a', 'c', 'd']) gate(id).open();
    await vi.waitFor(() => expect(engine.state.running.size).toBe(0));
    expect(engine.state.maxRunning).toBe(3);
  });

  it('reads workers.flowConcurrency from config, and the pool option wins', async () => {
    enqueue('a', 'b', 'c');
    const pool = await started({ config: makeConfig({ flowConcurrency: 2 }) });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engine.state.running.size).toBe(2);
    for (const id of ['a', 'b']) gate(id).open();
    await vi.waitFor(() => expect(isRunning('c')).toBe(true));
    gate('c').open();
    await vi.waitFor(() => expect(pool.flowCycleInFlight).toBe(false));

    enqueue('x', 'y');
    await started({ config: makeConfig({ flowConcurrency: 2 }), flowConcurrency: 1 });
    await vi.waitFor(() => expect(isRunning('x')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(isRunning('y')).toBe(false);
  });

  it('refuses a flowConcurrency that is not a whole number from 1 to 256', () => {
    for (const value of [0, -1, 1.5, 257, Number.NaN]) {
      expect(() => makePool({ flowConcurrency: value })).toThrow(/flowConcurrency/);
    }
  });

  it('fences every write with its own claim token and fails only the execution that threw', async () => {
    enqueue('ok', 'broken');
    await started({ flowConcurrency: 2 });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(2));

    const failure = new Error('step exploded');
    gate('broken').fail(failure);
    await vi.waitFor(() => expect(engine.mock.markFailedFromRunner).toHaveBeenCalledTimes(1));
    expect(engine.mock.markFailedFromRunner).toHaveBeenCalledWith(
      'broken',
      failure,
      'token-broken',
    );
    expect(isRunning('ok')).toBe(true);

    // A step that advances keeps the lease: the next step runs under the same token.
    gate('ok').open('running');
    await vi.waitFor(() => expect(engine.state.gates.get('ok')?.length).toBe(1));
    gate('ok').open();
    await vi.waitFor(() => expect(engine.state.running.size).toBe(0));

    const calls = engine.mock.runNext.mock.calls.map(([id, , token]) => [id, token]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['ok', 'token-ok'],
        ['broken', 'token-broken'],
      ]),
    );
    for (const [id, token] of calls) expect(token).toBe(`token-${id}`);
    expect(engine.mock.markFailedFromRunner).toHaveBeenCalledTimes(1);
  });

  it('stop() waits for every running execution, names them, and releases each with its token', async () => {
    enqueue('a', 'b', 'c');
    const logger = makeLogger();
    const pool = await started({ flowConcurrency: 3, logger });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(3));
    expect([...(pool.flowExecutionsInFlight ?? [])].sort()).toEqual(['a', 'b', 'c']);

    let stopped = false;
    const stopping = pool.stop({ deadlineAt: Date.now() + 10_000 }).then(() => {
      stopped = true;
    });
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        'Worker stopping: waiting for the running flow steps',
        expect.objectContaining({ executionIds: expect.arrayContaining(['a', 'b', 'c']) }),
      ),
    );

    // Each step finishes with the flow still running: it is released, not drained further.
    gate('a').open('running');
    gate('b').open('running');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    expect(pool.flowCycleInFlight).toBe(true);

    gate('c').open('running');
    await stopping;
    expect(pool.flowCycleInFlight).toBe(false);
    expect(pool.flowExecutionsInFlight).toEqual([]);
    expect(engine.mock.releaseClaim.mock.calls.sort()).toEqual([
      ['a', 'token-a'],
      ['b', 'token-b'],
      ['c', 'token-c'],
    ]);
    expect(engine.mock.runNext).toHaveBeenCalledTimes(3);
    expect(engine.mock.claimNext).toHaveBeenCalledTimes(3);
  });

  it('names every execution still running at the shutdown deadline', async () => {
    enqueue('a', 'b');
    const logger = makeLogger();
    const pool = await started({ flowConcurrency: 2, logger });
    await vi.waitFor(() => expect(engine.state.running.size).toBe(2));

    await pool.stop({ deadlineAt: Date.now() + 50 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Flow steps still running at the shutdown deadline; abandoned, their leases expire',
      expect.objectContaining({ executionIds: expect.arrayContaining(['a', 'b']) }),
    );
    expect(pool.flowCycleInFlight).toBe(true);

    gate('a').open();
    gate('b').open();
    await vi.waitFor(() => expect(pool.flowCycleInFlight).toBe(false));
  });
});
