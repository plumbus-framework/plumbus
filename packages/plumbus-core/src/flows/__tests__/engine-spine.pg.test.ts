import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/defineFlow.js';
import { flowExecutionsDdl } from '../../durable/apply-ddl.js';
import { createDurableTestHarness, type DurableTestHarness } from '../../durable/harness.js';
import {
  listSideEffects,
  listUnpublishedOutbox,
  loadExecutionState,
} from '../../durable/postgres-persist.js';
import { createOpaqueDispatchRecord } from '../../durable/opaque-dispatch.js';
import { upsertSpineDispatch } from '../../durable/spine-claim.js';
import type { DataPlaneResolver } from '../../tenancy/types.js';
import { deadLetterFlow, retryDeadLetteredFlow } from '../dead-letter.js';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import { FlowStepType } from '../../types/enums.js';
import { createFlowEngine } from '../engine.js';
import { FlowRegistry } from '../registry.js';
import { FlowStatus } from '../state-machine.js';

function makeFlow() {
  return defineFlow({
    name: 'durable-demo',
    domain: 'durable',
    input: z.object({ n: z.number() }),
    steps: [
      { name: 'alpha', type: FlowStepType.Capability, capability: 'durable.noop' },
      { name: 'beta', type: FlowStepType.Capability, capability: 'durable.noop' },
    ],
  });
}

describe('flow engine spine dispatch on two databases', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('starts on the tenant db, claims from the spine, and runs the existing step machine', async () => {
    harness = await createDurableTestHarness();
    const registry = new FlowRegistry();
    registry.register(makeFlow());
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
      spineDispatch: {
        db: harness.spineDb,
        resolver,
        coreSchema: harness.coreSchema,
      },
      flowLeaseDurationMs: 30_000,
    });

    const started = await engine.start(
      'durable-demo',
      { n: 1 },
      { userId: 'tester', roles: ['system'], scopes: [], provider: 'test', tenantId: 'tenant-a' },
    );
    expect(started.status).toBe(FlowStatus.Created);

    const accepted = await loadExecutionState(harness.tenantDb, started.id, harness.coreSchema);
    expect(accepted?.revision).toBe(1);
    expect(accepted?.tenantRef).toBe('tenant-a');

    const claimed = await engine.claimNext(5);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(started.id);

    const ctx = {
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
      translations: { locale: 'en', t: (key: string) => key },
    } as never;
    const afterFirst = await engine.runNext(started.id, ctx);
    expect([FlowStatus.Running, FlowStatus.Completed]).toContain(afterFirst.status);

    const effects = await listSideEffects(harness.tenantDb, harness.coreSchema);
    expect(effects.length).toBeGreaterThanOrEqual(1);
    expect(new Set(effects).size).toBe(effects.length);
  });
});

describe('flow engine spine dispatch with control-plane flows beside tenant flows', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  const systemCtx = (tenantId?: string) =>
    ({
      auth: { userId: 'system', roles: ['system'], scopes: [], provider: 'worker', tenantId },
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
      translations: { locale: 'en', t: (key: string) => key },
    }) as never;

  it('refuses an untenanted start by default, and places one on the spine under control-plane', async () => {
    harness = await createDurableTestHarness();
    // The spine of a mixed deployment carries its own flow_executions for control-plane flows.
    for (const statement of flowExecutionsDdl()
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await harness.spineDb.execute(sql.raw(`${statement};`));
    }
    const registry = new FlowRegistry();
    registry.register(makeFlow());
    const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
      coreSchema: harness.coreSchema,
    });
    const stepDeps = {
      executeCapability: async () => ({ success: true, data: {} }),
      evaluateCondition: () => true,
    };
    const untenantedAuth = { userId: 'operator', roles: ['system'], scopes: [], provider: 'test' };

    const refusing = createFlowEngine({
      db: harness.spineDb,
      registry,
      stepDeps,
      spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
    });
    await expect(refusing.start('durable-demo', { n: 1 }, untenantedAuth)).rejects.toMatchObject({
      metadata: { reason: 'untenanted-flow-start' },
    });

    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      stepDeps,
      spineDispatch: {
        db: harness.spineDb,
        resolver,
        coreSchema: harness.coreSchema,
        untenanted: 'control-plane',
      },
      flowLeaseDurationMs: 30_000,
    });

    const controlPlane = await engine.start('durable-demo', { n: 1 }, untenantedAuth);
    const tenant = await engine.start(
      'durable-demo',
      { n: 2 },
      { ...untenantedAuth, tenantId: 'tenant-a' },
    );

    // The control-plane flow is a spine row and nothing else; the tenant flow is a tenant row
    // with acceptance state and a spine hint — and no spine row of its own.
    const spineRows = (await harness.spineDb.execute(
      sql`SELECT id, tenant_id FROM flow_executions`,
    )) as unknown as Array<{ id: string; tenant_id: string | null }>;
    expect(spineRows.map((row) => row.id)).toEqual([controlPlane.id]);
    expect(spineRows[0]?.tenant_id).toBeNull();
    const tenantRows = (await harness.tenantDb.execute(
      sql`SELECT id FROM flow_executions`,
    )) as unknown as Array<{ id: string }>;
    expect(tenantRows.map((row) => row.id)).toEqual([tenant.id]);
    expect(
      (await loadExecutionState(harness.tenantDb, tenant.id, harness.coreSchema))?.tenantRef,
    ).toBe('tenant-a');
    expect(
      await loadExecutionState(harness.tenantDb, controlPlane.id, harness.coreSchema),
    ).toBeUndefined();

    // Claim finds both: the tenant hint from the spine and the control-plane row beside it.
    const claimed = await engine.claimNext(5);
    expect(claimed.map((row) => row.id).sort()).toEqual([controlPlane.id, tenant.id].sort());

    for (const row of claimed) {
      let result = await engine.runNext(row.id, systemCtx(row.tenantId ?? undefined));
      while (result.status === FlowStatus.Running) {
        // Between drained steps the follow-up hint is on the spine under this worker's lease:
        // a second worker polling now claims nothing.
        expect(await engine.claimNext(5)).toEqual([]);
        result = await engine.runNext(row.id, systemCtx(row.tenantId ?? undefined));
      }
      expect(result.status).toBe(FlowStatus.Completed);
    }

    // The drain left nothing behind: every hint acknowledged, the durable state terminal,
    // every outbox row closed, and nothing for the outbox pump to publish again.
    const hints = (await harness.spineDb.execute(
      sql`SELECT delivery_state, lease_ref_id FROM opaque_dispatch WHERE execution_id = ${tenant.id}`,
    )) as unknown as Array<{ delivery_state: string; lease_ref_id: string | null }>;
    expect(hints).toHaveLength(2);
    expect(hints.every((hint) => hint.delivery_state === 'acknowledged')).toBe(true);
    const finalState = await loadExecutionState(harness.tenantDb, tenant.id, harness.coreSchema);
    expect(finalState?.terminal).toBe(true);
    expect(finalState?.status).toBe('succeeded');
    const openOutbox = (await harness.tenantDb.execute(
      sql.raw(
        `SELECT count(*)::int AS n FROM ${harness.coreSchema}.dispatch_outbox WHERE spine_acked_at IS NULL`,
      ),
    )) as unknown as Array<{ n: number }>;
    expect(openOutbox[0]?.n).toBe(0);
    expect(await listUnpublishedOutbox(harness.tenantDb, harness.coreSchema)).toEqual([]);
    expect(await engine.claimNext(5)).toEqual([]);

    // A fresh engine that never started or claimed the tenant flow still finds its row
    // through the spine hint, and finds the control-plane row on the spine.
    const stranger = createFlowEngine({
      db: harness.spineDb,
      registry,
      stepDeps,
      spineDispatch: {
        db: harness.spineDb,
        resolver,
        coreSchema: harness.coreSchema,
        untenanted: 'control-plane',
      },
    });
    expect((await stranger.status(tenant.id)).status).toBe(FlowStatus.Completed);
    expect((await stranger.status(controlPlane.id)).status).toBe(FlowStatus.Completed);
  });
});

describe('flow engine spine dispatch: operator cancel and retry of tenant-placed executions', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  const systemCtx = (tenantId?: string) =>
    ({
      auth: { userId: 'system', roles: ['system'], scopes: [], provider: 'worker', tenantId },
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
      translations: { locale: 'en', t: (key: string) => key },
    }) as never;

  async function hintStates(executionId: string): Promise<string[]> {
    const rows = (await harness.spineDb.execute(
      sql`SELECT delivery_state FROM opaque_dispatch WHERE execution_id = ${executionId} ORDER BY created_at`,
    )) as unknown as Array<{ delivery_state: string }>;
    return rows.map((row) => row.delivery_state);
  }

  it('drops the hint of an execution cancelled before a worker claimed it, and republishes one on operator retry', async () => {
    harness = await createDurableTestHarness();
    const registry = new FlowRegistry();
    registry.register(makeFlow());
    const resolver = createSingleDataPlaneResolver(harness.tenantDb, {
      coreSchema: harness.coreSchema,
    });
    let failAlpha = false;
    const stepDeps = {
      executeCapability: async () =>
        failAlpha
          ? { success: false as const, error: 'boom' }
          : { success: true as const, data: {} },
      evaluateCondition: () => true,
    };
    const tenantAuth = {
      userId: 'tester',
      roles: ['system'],
      scopes: [],
      provider: 'test',
      tenantId: 'tenant-a',
    };
    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      stepDeps,
      spineDispatch: { db: harness.spineDb, resolver, coreSchema: harness.coreSchema },
      flowLeaseDurationMs: 30_000,
    });

    // Cancel before any claim: the row is cancelled, the durable state closed, and the next
    // claim acknowledges the ready hint instead of reviving the row.
    const cancelled = await engine.start('durable-demo', { n: 1 }, tenantAuth);
    expect(await hintStates(cancelled.id)).toEqual(['ready']);
    await engine.cancel(cancelled.id);
    expect((await engine.status(cancelled.id)).status).toBe(FlowStatus.Cancelled);
    const closedState = await loadExecutionState(
      harness.tenantDb,
      cancelled.id,
      harness.coreSchema,
    );
    expect(closedState?.terminal).toBe(true);
    expect(closedState?.status).toBe('cancelled');
    expect(await engine.claimNext(5)).toEqual([]);
    expect(await hintStates(cancelled.id)).toEqual(['acknowledged']);
    expect((await engine.status(cancelled.id)).status).toBe(FlowStatus.Cancelled);

    // Fail one terminally, dead-letter it, and retry it as an operator: without a fresh hint
    // the reset row would never be claimed again.
    failAlpha = true;
    const failing = await engine.start('durable-demo', { n: 2 }, tenantAuth);
    const claimed = await engine.claimNext(5);
    expect(claimed.map((row) => row.id)).toEqual([failing.id]);
    expect((await engine.runNext(failing.id, systemCtx('tenant-a'))).status).toBe(
      FlowStatus.Failed,
    );
    expect(await hintStates(failing.id)).toEqual(['acknowledged']);
    expect(
      (await loadExecutionState(harness.tenantDb, failing.id, harness.coreSchema))?.terminal,
    ).toBe(true);
    expect(await engine.claimNext(5)).toEqual([]);

    await deadLetterFlow(harness.tenantDb, failing.id);
    failAlpha = false;
    const retried = await retryDeadLetteredFlow(
      harness.tenantDb,
      failing.id,
      { actor: 'operator', reason: 'transient' },
      { spineDb: harness.spineDb, coreSchema: harness.coreSchema },
    );
    expect(retried.republished).toBe(true);
    expect(await hintStates(failing.id)).toEqual(['acknowledged', 'ready']);
    const reopened = await loadExecutionState(harness.tenantDb, failing.id, harness.coreSchema);
    expect(reopened?.terminal).toBe(false);
    expect(reopened?.revision).toBe(3);

    const reclaimed = await engine.claimNext(5);
    expect(reclaimed.map((row) => row.id)).toEqual([failing.id]);
    // As the worker does it: drain the remaining steps under the lease the claim took.
    let result = await engine.runNext(failing.id, systemCtx('tenant-a'));
    while (result.status === FlowStatus.Running) {
      result = await engine.runNext(failing.id, systemCtx('tenant-a'));
    }
    expect(result.status).toBe(FlowStatus.Completed);
    expect(await hintStates(failing.id)).not.toContain('ready');
    expect(
      (await loadExecutionState(harness.tenantDb, failing.id, harness.coreSchema))?.terminal,
    ).toBe(true);

    // A retry without placement resets the row but publishes nothing: the caller said the
    // execution is claimed from its own table.
    failAlpha = true;
    const local = await engine.start('durable-demo', { n: 3 }, tenantAuth);
    await engine.claimNext(5);
    expect((await engine.runNext(local.id, systemCtx('tenant-a'))).status).toBe(FlowStatus.Failed);
    await deadLetterFlow(harness.tenantDb, local.id);
    const unplaced = await retryDeadLetteredFlow(harness.tenantDb, local.id, { actor: 'operator' });
    expect(unplaced.republished).toBe(false);
    expect(await hintStates(local.id)).toEqual(['acknowledged']);
  });
});

describe('flow engine spine dispatch: hints whose plane never resolves', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('parks a hint as dead-lettered after the configured number of failed claims', async () => {
    harness = await createDurableTestHarness();
    const registry = new FlowRegistry();
    registry.register(makeFlow());
    const inner = createSingleDataPlaneResolver(harness.tenantDb, {
      coreSchema: harness.coreSchema,
    });
    const resolver: DataPlaneResolver = {
      resolve: async (tenantRef) => {
        if (tenantRef === 'tenant-gone') throw new Error('no route for tenant-gone');
        return inner.resolve(tenantRef);
      },
    };
    const engine = createFlowEngine({
      db: harness.spineDb,
      registry,
      stepDeps: {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
      spineDispatch: {
        db: harness.spineDb,
        resolver,
        coreSchema: harness.coreSchema,
        maxClaimAttempts: 2,
      },
      flowLeaseDurationMs: 20,
    });
    const nowIso = new Date().toISOString();
    await upsertSpineDispatch(
      harness.spineDb,
      createOpaqueDispatchRecord({
        dispatchId: 'disp:orphan:1',
        tenantRouteId: 'tenant-gone',
        executionId: 'orphan',
        definitionId: 'durable.durable-demo',
        definitionVersion: '1',
        stepId: 'alpha',
        tenantExecutionStateRefId: 'state:orphan',
        expectedRevision: 1,
        tenantEpoch: 1,
        workClassId: 'plumbus.work.flow-step',
        priorityClassId: 'plumbus.priority.normal',
        deliveryState: 'ready',
        attempt: 0,
        notBefore: nowIso,
        correlationId: 'corr-orphan',
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    );
    const stateOf = async () => {
      const rows = (await harness.spineDb.execute(
        sql`SELECT delivery_state, attempt, privacy_safe_failure_category_id AS category FROM opaque_dispatch WHERE dispatch_id = 'disp:orphan:1'`,
      )) as unknown as Array<{ delivery_state: string; attempt: number; category: string | null }>;
      return rows[0];
    };

    // First claim: leased, the plane fails to resolve, the hint stays for its lease to lapse.
    expect(await engine.claimNext(5)).toEqual([]);
    expect(await stateOf()).toMatchObject({ delivery_state: 'leased', attempt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Second claim: the cap is reached, the hint is parked and never re-leased.
    expect(await engine.claimNext(5)).toEqual([]);
    expect(await stateOf()).toMatchObject({
      delivery_state: 'dead-lettered',
      attempt: 2,
      category: 'plane-unresolved',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await engine.claimNext(5)).toEqual([]);
    expect((await stateOf()).attempt).toBe(2);
  });
});
