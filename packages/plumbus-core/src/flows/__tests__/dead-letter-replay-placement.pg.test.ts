import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { flowExecutionsDdl } from '../../durable/apply-ddl.js';
import {
  createDurableTestDatabase,
  createDurableTestHarness,
  type DurableTestHarness,
  extraHarnessConnection,
} from '../../durable/harness.js';
import { resolveTestPostgresAdmin } from '../../durable/pg-env.js';
import { loadExecutionState } from '../../durable/postgres-persist.js';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { FlowStepType } from '../../types/enums.js';
import { compileFlowDefinition } from '../compile-flow.js';
import { CompiledFlowRegistry } from '../compiled-registry.js';
import { replayDeadLetterFlow, retryDeadLetteredFlow } from '../dead-letter.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { flowDeadLetterTable, flowExecutionsTable } from '../schema.js';
import { FlowStatus } from '../state-machine.js';

const ctx = () =>
  ({
    auth: {
      userId: 'system',
      roles: ['system'],
      scopes: [],
      provider: 'worker',
      tenantId: 'tenant-a',
    },
    data: {},
    events: { emit: async () => undefined, emitMany: async () => undefined },
    flows: {
      start: async () => ({}),
      resume: async () => undefined,
      cancel: async () => undefined,
      status: async () => ({}),
    },
    ai: {},
    audit: { record: async () => undefined },
    errors: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    time: { now: () => new Date() },
    config: {},
    security: {},
    translations: { locale: 'en', t: (k: string) => k },
  }) as never;

describe('dead-letter replay and in-place retry on a tenant data plane', () => {
  let harness: DurableTestHarness;
  afterAll(async () => {
    await harness?.close();
  });

  it('replays a tenant-placed dead letter with pin, actor, acceptance and hint; in-place retry refused after', async () => {
    harness = await createDurableTestHarness();
    const flow = defineFlow({
      name: 'replay-placement',
      domain: 'durable',
      input: z.object({}),
      budget: { profileId: 'p', allocated: 5 },
      steps: [
        { name: 'alpha', type: FlowStepType.Capability, capability: 'durable.a' },
        { name: 'beta', type: FlowStepType.Capability, capability: 'durable.b' },
      ],
    });
    const registry = new FlowRegistry();
    registry.register(flow);
    const compiledRegistry = new CompiledFlowRegistry();
    const compiled = compileFlowDefinition(flow, { definitionVersion: '7' });
    compiledRegistry.publish(compiled);
    const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
      coreSchema: harness.coreSchema,
    });
    let failBeta = true;
    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      compiledRegistry,
      stepDeps: {
        executeCapability: async (name: string) =>
          name === 'durable.b' && failBeta
            ? { success: false, error: 'boom' }
            : { success: true, data: {} },
        evaluateCondition: () => true,
      },
      spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
      flowLeaseDurationMs: 30_000,
    });
    const auth = {
      userId: 'tester',
      roles: ['system'],
      scopes: [],
      provider: 'test',
      tenantId: 'tenant-a',
    };
    const started = await engine.start('replay-placement', {}, auth);
    const [row0] = await harness.tenantDb
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, started.id));
    expect(row0?.definitionVersion).toBe('7');
    expect((row0?.state as any).__budget.amounts[0].allocated).toBe(5);
    const claimed = await engine.claimNext(5);
    expect(claimed[0]?.leaseToken).toBeTruthy();
    let result = await engine.runNext(started.id, ctx(), claimed[0]?.leaseToken ?? undefined);
    while (result.status === FlowStatus.Running) result = await engine.runNext(started.id, ctx());
    expect(result.status).toBe(FlowStatus.Failed);
    const dlq = await harness.tenantDb.select().from(flowDeadLetterTable);
    expect(dlq).toHaveLength(1);

    const replayId = await replayDeadLetterFlow(harness.tenantDb, registry, started.id, {
      actor: 'ops-ada',
      reason: 'fixed',
      placement: { spineDb: harness.spineDb, coreSchema: harness.coreSchema },
    });
    expect(
      await replayDeadLetterFlow(harness.tenantDb, registry, started.id, {
        actor: 'x',
        placement: { spineDb: harness.spineDb, coreSchema: harness.coreSchema },
      }),
    ).toBe(replayId);
    const [replay] = await harness.tenantDb
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, replayId));
    expect(replay).toMatchObject({
      currentStep: 'beta',
      replayOf: started.id,
      definitionVersion: '7',
      definitionDigest: compiled.definitionDigest,
      status: 'created',
    });
    const [meta] = await harness.tenantDb.select().from(flowDeadLetterTable);
    expect(meta?.metadata).toMatchObject({
      replayExecutionId: replayId,
      replayedBy: 'ops-ada',
      replayReason: 'fixed',
    });
    expect(
      (await loadExecutionState(harness.tenantDb, replayId, harness.coreSchema))?.currentStepId,
    ).toBe('beta');
    const hints = (await harness.spineDb.execute(
      sql`SELECT delivery_state FROM opaque_dispatch WHERE execution_id = ${replayId}`,
    )) as unknown as Array<{ delivery_state: string }>;
    expect(hints.map((h) => h.delivery_state)).toEqual(['ready']);
    await expect(
      retryDeadLetteredFlow(harness.tenantDb, started.id, { actor: 'ops' }),
    ).rejects.toThrow('already replayed');

    failBeta = false;
    const second = createFlowEngine({
      db: harness.spineDb,
      registry,
      compiledRegistry,
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
      spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
      flowLeaseDurationMs: 30_000,
    });
    const reclaimed = await second.claimNext(5);
    expect(reclaimed.map((r) => r.id)).toEqual([replayId]);
    expect((await second.runNext(replayId, ctx())).status).toBe(FlowStatus.Completed);
  });

  it('fails a budget-exhausted step without retries even with a retry policy', async () => {
    const flow = defineFlow({
      name: 'budget-exhaustion',
      domain: 'durable',
      input: z.object({}),
      budget: { profileId: 'p', allocated: 1 },
      retry: { maxAttempts: 3 },
      steps: [
        { name: 'a', type: FlowStepType.Capability, capability: 'x.a' },
        { name: 'b', type: FlowStepType.Capability, capability: 'x.b' },
      ],
    });
    const registry = new FlowRegistry();
    registry.register(flow);
    const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
      coreSchema: harness.coreSchema,
    });
    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
      spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
      flowLeaseDurationMs: 30_000,
    });
    const started = await engine.start(
      'budget-exhaustion',
      {},
      { userId: 'u', roles: [], scopes: [], provider: 't', tenantId: 'tenant-a' },
    );
    await engine.claimNext(5);
    expect((await engine.runNext(started.id, ctx())).status).toBe(FlowStatus.Running);
    expect((await engine.runNext(started.id, ctx())).status).toBe(FlowStatus.Failed);
    const [row] = await harness.tenantDb
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, started.id));
    expect(row?.lastError).toBe('budget-exhausted');
    expect(
      (await loadExecutionState(harness.tenantDb, started.id, harness.coreSchema))?.terminal,
    ).toBe(true);
  });
});

describe('in-place retry racing a replay of the same dead letter', () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of closers.reverse()) await close();
  });

  it('serialises on the dead-letter lock: whichever commits second is refused', async () => {
    const admin = resolveTestPostgresAdmin();
    const plane = await createDurableTestDatabase({
      admin,
      kind: 'dlqrace',
      ddl: flowExecutionsDdl(),
    });
    closers.push(plane.close);
    const replayer = await extraHarnessConnection(admin, plane.name);
    closers.push(replayer.close);
    const observer = await extraHarnessConnection(admin, plane.name);
    closers.push(observer.close);

    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: 'race-fail',
        domain: 'durable',
        input: z.object({}),
        retry: { attempts: 0, backoff: 'fixed' },
        steps: [{ name: 'boom', type: FlowStepType.Capability, capability: 'durable.boom' }],
      }),
    );
    const engine = createFlowEngine({
      db: plane.db,
      registry,
      stepDeps: {
        executeCapability: async () => ({ success: false, error: 'boom' }),
        evaluateCondition: () => true,
      },
      flowLeaseDurationMs: 30_000,
    });
    const auth = { userId: 'tester', roles: ['system'], scopes: [], provider: 'test' };
    async function deadLettered(): Promise<string> {
      const started = await engine.start('race-fail', {}, auth);
      for (let attempt = 0; attempt < 8; attempt++) {
        if ((await engine.claimNext(5)).some((row) => row.id === started.id)) break;
      }
      expect((await engine.runNext(started.id, ctx())).status).toBe(FlowStatus.Failed);
      const rows = await plane.db
        .select()
        .from(flowDeadLetterTable)
        .where(eq(flowDeadLetterTable.executionId, started.id));
      expect(rows).toHaveLength(1);
      return started.id;
    }
    async function sourceStatus(executionId: string): Promise<string | undefined> {
      const [row] = await observer.db
        .select({ status: flowExecutionsTable.status })
        .from(flowExecutionsTable)
        .where(eq(flowExecutionsTable.id, executionId));
      return row?.status;
    }

    // A replay holds the dead letter FOR UPDATE (as replayDeadLetterFlow does) while an
    // in-place retry of the same failure starts.
    const first = await deadLettered();
    const replayExecutionId = randomUUID();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const replay = replayer.db.transaction(async (tx) => {
      const [deadLetter] = await tx
        .select()
        .from(flowDeadLetterTable)
        .where(eq(flowDeadLetterTable.executionId, first))
        .for('update');
      locked();
      await released;
      await tx
        .update(flowDeadLetterTable)
        .set({ metadata: { ...(deadLetter?.metadata as object), replayExecutionId } })
        .where(eq(flowDeadLetterTable.executionId, first));
    });
    await lockHeld;
    const retry = retryDeadLetteredFlow(plane.db, first, { actor: 'ops' });
    retry.catch(() => undefined);
    // The retry waits on the dead-letter lock before it reads or resets anything.
    for (let waited = 0; ; waited += 25) {
      const waiting = (await observer.db.execute(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )) as unknown as Array<{ n: number }>;
      if ((waiting[0]?.n ?? 0) > 0) break;
      if (waited > 10_000) throw new Error('in-place retry never waited on the dead-letter lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await sourceStatus(first)).toBe(FlowStatus.Failed);
    release();
    await replay;
    await expect(retry).rejects.toThrow(`already replayed as "${replayExecutionId}"`);
    expect(await sourceStatus(first)).toBe(FlowStatus.Failed);
    const [kept] = await observer.db
      .select()
      .from(flowDeadLetterTable)
      .where(eq(flowDeadLetterTable.executionId, first));
    expect(kept?.metadata).toMatchObject({ replayExecutionId });
    expect(kept?.metadata).not.toHaveProperty('retriedAt');

    // The other order: the in-place retry commits first, so the replay finds no failed source.
    const second = await deadLettered();
    await retryDeadLetteredFlow(plane.db, second, { actor: 'ops' });
    await expect(
      replayDeadLetterFlow(plane.db, registry, second, { actor: 'ops' }),
    ).rejects.toThrow('Replay requires a failed source execution');
    expect(await sourceStatus(second)).toBe(FlowStatus.Created);
  });
});
