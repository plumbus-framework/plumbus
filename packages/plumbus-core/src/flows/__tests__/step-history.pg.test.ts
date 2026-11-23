// Step history of a running flow execution against real Postgres (core 0.9.0-beta.15, #205):
// `stepHistoryLimit` bounds the stored history of a flow that loops through its steps while
// cancellation still compensates every step that completed, and a step writes `state` only
// when it changed it.

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import {
  createDurableTestDatabase,
  flowExecutionsDdl,
  resolveTestPostgresAdmin,
} from '../../durable/index.js';
import { FlowStepType } from '../../types/enums.js';
import { capStepHistory, createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { FlowStatus, type StepHistoryEntry, StepStatus } from '../state-machine.js';

const admin = resolveTestPostgresAdmin();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const LOOPS = 30;

function loopingFlow() {
  return defineFlow({
    name: 'poll-until-ready',
    domain: 'probe',
    input: z.object({}),
    steps: [
      {
        name: 'reserve',
        type: FlowStepType.Capability,
        capability: 'probe.reserve',
        compensate: 'probe.release',
      },
      { name: 'poll', type: FlowStepType.Capability, capability: 'probe.poll' },
      { name: 'loop', type: FlowStepType.Conditional, if: 'notReady', then: 'poll', else: 'park' },
      { name: 'park', type: FlowStepType.Wait, event: 'probe.released' },
    ],
  } as never);
}

async function setup(stepHistoryLimit?: number) {
  const created = await createDurableTestDatabase({
    admin,
    kind: 'history',
    ddl: flowExecutionsDdl(),
  });
  cleanups.push(() => created.close());
  const client = postgres({
    host: admin.host,
    port: admin.port,
    database: created.name,
    username: admin.user,
    password: admin.password,
    max: 1,
    onnotice: () => {},
  });
  cleanups.push(() => client.end({ timeout: 5 }));
  const queries: string[] = [];
  const db = drizzle(client, { logger: { logQuery: (query) => queries.push(query) } });
  const registry = new FlowRegistry();
  registry.register(loopingFlow());
  let evaluations = 0;
  const executeCapability = vi.fn(async () => ({ success: true as const }));
  const engine = createFlowEngine({
    db,
    registry,
    stepDeps: {
      executeCapability,
      evaluateCondition: () => {
        evaluations += 1;
        return evaluations <= LOOPS;
      },
    } as never,
    ...(stepHistoryLimit !== undefined ? { stepHistoryLimit } : {}),
  });
  return { db: created.db as PostgresJsDatabase, engine, queries, executeCapability };
}

const ctx = {
  auth: { userId: 'tester', roles: ['system'], scopes: [], provider: 'test' },
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
} as never;

async function runToWait(engine: ReturnType<typeof createFlowEngine>): Promise<string> {
  const started = await engine.start(
    'poll-until-ready',
    {},
    {
      userId: 'tester',
      roles: ['system'],
      scopes: [],
      provider: 'test',
    },
  );
  const [claimed] = await engine.claimNext(1);
  expect(claimed?.id).toBe(started.id);
  for (let index = 0; index < 500; index += 1) {
    const result = await engine.runNext(started.id, ctx, claimed?.leaseToken ?? undefined);
    if (result.status !== FlowStatus.Running) break;
  }
  expect((await engine.status(started.id)).status).toBe(FlowStatus.Waiting);
  return started.id;
}

async function storedHistory(db: PostgresJsDatabase, id: string): Promise<StepHistoryEntry[]> {
  const [row] = [
    ...(await db.execute<{ step_history: StepHistoryEntry[] }>(
      sql`SELECT step_history FROM flow_executions WHERE id = ${id}`,
    )),
  ];
  return row?.step_history ?? [];
}

describe('capStepHistory', () => {
  const entry = (step: string, status: StepStatus): StepHistoryEntry => ({
    step,
    status,
    startedAt: 't',
  });

  it('keeps the newest entries and the newest completed entry of every older step, in order', () => {
    const history = [
      entry('reserve', StepStatus.Completed),
      entry('charge', StepStatus.Failed),
      entry('charge', StepStatus.Completed),
      entry('charge', StepStatus.Failed),
      entry('poll', StepStatus.Completed),
      entry('poll', StepStatus.Completed),
      entry('loop', StepStatus.Completed),
    ];
    expect(capStepHistory(history, 2)).toEqual([history[0], history[2], history[5], history[6]]);
    expect(capStepHistory(history, 0)).toBe(history);
    expect(capStepHistory(history, 10)).toBe(history);
    const completed = (list: StepHistoryEntry[]) =>
      new Set(list.filter((e) => e.status === StepStatus.Completed).map((e) => e.step));
    expect(completed(capStepHistory(history, 1))).toEqual(completed(history));
  });
});

describe('flow step history', () => {
  it('keeps every entry by default, as before', async () => {
    const { db, engine } = await setup();
    const id = await runToWait(engine);
    // reserve, then poll + loop for every pass, the last loop choosing park, then park.
    expect(await storedHistory(db, id)).toHaveLength(1 + (LOOPS + 1) * 2 + 1);
  });

  it('bounds a looping flow at stepHistoryLimit and still compensates a step that left the tail', async () => {
    const { db, engine, executeCapability } = await setup(6);
    const id = await runToWait(engine);
    const history = await storedHistory(db, id);
    expect(history.length).toBeLessThanOrEqual(6 + 1);
    expect(history.map((e) => e.step)).toContain('reserve');
    expect(history.at(-1)?.step).toBe('park');

    await engine.cancel(id);
    expect(executeCapability).toHaveBeenCalledWith('probe.release', expect.anything(), {});
    expect((await storedHistory(db, id)).map((e) => e.step)).toContain('compensate:reserve');
  });

  it('writes state only when the step changed it', async () => {
    const { engine, queries } = await setup();
    await runToWait(engine);
    const stepWrites = queries.filter(
      (query) => query.startsWith('update "flow_executions"') && query.includes('"step_history"'),
    );
    expect(stepWrites.length).toBeGreaterThan(LOOPS);
    // No step returned data: the state column is never rewritten.
    for (const query of stepWrites) expect(query).not.toContain('"state" =');
  });

  it('refuses a stepHistoryLimit that is not a whole number', () => {
    expect(() =>
      createFlowEngine({
        db: {} as never,
        registry: new FlowRegistry(),
        stepDeps: {} as never,
        stepHistoryLimit: -1,
      }),
    ).toThrow(/stepHistoryLimit/);
  });
});
