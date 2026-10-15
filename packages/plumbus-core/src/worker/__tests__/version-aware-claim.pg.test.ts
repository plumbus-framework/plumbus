// A worker that claims an execution whose definition it lacks releases it (runnable, lease
// cleared) instead of failing it, does not take it again at once, and a worker that has the
// definition runs it. Own-table claims and spine-hint claims, live and compiled definitions.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../define/index.js';
import {
  createDurableTestDatabase,
  createDurableTestHarness,
  flowExecutionsDdl,
} from '../../durable/index.js';
import { ConsumerRegistry, createInMemoryQueue } from '../../events/index.js';
import type { FlowDefinitionUnavailableInfo } from '../../flows/engine.js';
import { compileFlowDefinition } from '../../flows/compile-flow.js';
import { CompiledFlowRegistry } from '../../flows/compiled-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import { createPlumbusMetrics } from '../../observability/metrics.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { FlowDefinition } from '../../types/flow.js';
import { FlowStepType } from '../../types/enums.js';
import { createWorkerPool, type WorkerPool, type WorkerPoolConfig } from '../index.js';

const auth = { userId: 'u1', roles: ['admin'], scopes: [], provider: 'test' };
const tenantAuth = { ...auth, tenantId: 'tenant-a' };

function flow(name: string, steps: string[]): FlowDefinition {
  return defineFlow({
    name,
    domain: 'testing',
    input: z.object({}),
    steps: steps.map((step) => ({
      name: step,
      type: FlowStepType.Capability,
      capability: `testing.${step}`,
    })),
  });
}

function registryOf(...flows: FlowDefinition[]): FlowRegistry {
  const registry = new FlowRegistry();
  for (const definition of flows) registry.register(definition);
  return registry;
}

interface Worker {
  pool: WorkerPool;
  ran: string[];
  unavailable: FlowDefinitionUnavailableInfo[];
  metrics: ReturnType<typeof createPlumbusMetrics>;
}

function worker(
  db: PostgresJsDatabase,
  flows: FlowRegistry,
  extra: Partial<WorkerPoolConfig> = {},
): Worker {
  const ran: string[] = [];
  const unavailable: FlowDefinitionUnavailableInfo[] = [];
  const metrics = createPlumbusMetrics();
  const pool = createWorkerPool({
    config: { environment: 'test' } as PlumbusConfig,
    db,
    flows,
    consumers: new ConsumerRegistry(),
    queue: createInMemoryQueue(),
    audit: { record: async () => {} },
    enableScheduler: false,
    enableDispatcher: false,
    enableEventWorker: false,
    flowPollIntervalMs: 20,
    flowLeaseDurationMs: 60_000,
    metrics,
    logger: {
      debug() {},
      info() {},
      warn(message, metadata) {
        if (message.startsWith('definition-unavailable'))
          unavailable.push(metadata as unknown as FlowDefinitionUnavailableInfo);
      },
      error() {},
    },
    stepDeps: {
      async executeCapability(name) {
        ran.push(name);
        return { success: true, data: {} };
      },
      evaluateCondition: () => true,
    },
    ...extra,
  });
  return { pool, ran, unavailable, metrics };
}

async function row(db: PostgresJsDatabase, id: string) {
  const rows = await db.execute<{
    status: string;
    lease_owner: string | null;
    lease_expired: boolean | null;
  }>(sql`
    SELECT status, lease_owner, lease_expires_at <= now() AS lease_expired
    FROM flow_executions WHERE id = ${id}
  `);
  return [...rows][0];
}

async function deadLetters(db: PostgresJsDatabase): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM flow_dead_letter`,
  );
  return [...rows][0]?.n ?? 0;
}

/** Long enough for dozens of 20 ms poll cycles. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

async function stopAll(...workers: Worker[]) {
  for (const w of workers) await w.pool.stop();
}

describe('version-aware claim', () => {
  it('own table: an old worker releases a flow it does not have; a new worker runs it', async () => {
    const database = await createDurableTestDatabase({ kind: 'p7_own', ddl: flowExecutionsDdl() });
    const newFlow = flow('added-later', ['only']);
    const old = worker(database.db, registryOf(flow('existing', ['only'])));
    const current = worker(database.db, registryOf(newFlow));
    try {
      const started = await current.pool.flowEngine.start('added-later', {}, auth);
      await old.pool.start();
      await vi.waitFor(() => expect(old.unavailable).toHaveLength(1));
      await settle();
      // Released once and skipped since: no hot loop, nothing failed, nothing ran.
      expect(old.unavailable).toHaveLength(1);
      expect(old.unavailable[0]).toMatchObject({
        executionId: started.id,
        flowName: 'added-later',
        reason: 'flow-not-registered',
        workerId: old.pool.flowEngine.workerId,
      });
      expect(old.metrics.registry.serialize()).toContain(
        'plumbus_flow_definition_unavailable_total{flow="added-later",reason="flow-not-registered"} 1',
      );
      expect(await row(database.db, started.id)).toEqual({
        status: 'running',
        lease_owner: null,
        lease_expired: true,
      });
      expect(await deadLetters(database.db)).toBe(0);
      expect(old.ran).toEqual([]);

      await current.pool.start();
      await vi.waitFor(async () =>
        expect((await current.pool.flowEngine.status(started.id)).status).toBe('completed'),
      );
      expect(current.ran).toEqual(['testing.only']);
    } finally {
      await stopAll(old, current);
      await database.close();
    }
  }, 30_000);

  it('own table: a live definition missing the current step releases instead of failing', async () => {
    const database = await createDurableTestDatabase({ kind: 'p7_step', ddl: flowExecutionsDdl() });
    const old = worker(database.db, registryOf(flow('evolving', ['first'])));
    const current = worker(database.db, registryOf(flow('evolving', ['first', 'added'])));
    try {
      const started = await current.pool.flowEngine.start('evolving', {}, auth);
      // The new release already ran `first`; the execution now waits at a step only it has.
      await database.db.execute(
        sql`UPDATE flow_executions SET current_step = 'added' WHERE id = ${started.id}`,
      );
      await old.pool.start();
      await vi.waitFor(() => expect(old.unavailable).toHaveLength(1));
      expect(old.unavailable[0]?.reason).toBe('step-not-found');
      await settle();
      expect(old.unavailable).toHaveLength(1);
      expect((await row(database.db, started.id))?.status).toBe('running');
      expect(await deadLetters(database.db)).toBe(0);

      await current.pool.start();
      await vi.waitFor(async () =>
        expect((await current.pool.flowEngine.status(started.id)).status).toBe('completed'),
      );
      expect(current.ran).toEqual(['testing.added']);
      expect(old.ran).toEqual([]);
    } finally {
      await stopAll(old, current);
      await database.close();
    }
  }, 30_000);

  it('own table: a pinned compiled version that is missing, or has another digest, is released', async () => {
    const database = await createDurableTestDatabase({ kind: 'p7_pin', ddl: flowExecutionsDdl() });
    const v1 = flow('pinned', ['a']);
    const v2 = flow('pinned', ['a', 'b']);
    const compiledFor = (definition: FlowDefinition, version: string) => {
      const compiled = new CompiledFlowRegistry();
      compiled.publish(compileFlowDefinition(definition, { definitionVersion: version }));
      return compiled;
    };
    // Version 2 only on the new release; the old release has 1, and a third copy has a
    // version 2 compiled from other steps (same version, another digest).
    const current = worker(database.db, registryOf(v2), { compiledRegistry: compiledFor(v2, '2') });
    const old = worker(database.db, registryOf(v1), { compiledRegistry: compiledFor(v1, '1') });
    const drifted = worker(database.db, registryOf(v1), {
      compiledRegistry: compiledFor(v1, '2'),
    });
    try {
      const started = await current.pool.flowEngine.start('pinned', {}, auth);
      await old.pool.start();
      await drifted.pool.start();
      await vi.waitFor(() => {
        expect(old.unavailable.map((info) => info.reason)).toEqual(['compiled-version-missing']);
        expect(drifted.unavailable.map((info) => info.reason)).toEqual([
          'compiled-digest-mismatch',
        ]);
      });
      expect(old.unavailable[0]?.definitionVersion).toBe('2');
      expect((await row(database.db, started.id))?.status).toBe('running');

      await current.pool.start();
      await vi.waitFor(async () =>
        expect((await current.pool.flowEngine.status(started.id)).status).toBe('completed'),
      );
      expect(current.ran).toEqual(['testing.a', 'testing.b']);
      expect([...old.ran, ...drifted.ran]).toEqual([]);
      expect(await deadLetters(database.db)).toBe(0);
    } finally {
      await stopAll(old, drifted, current);
      await database.close();
    }
  }, 30_000);

  it('spine hints: an old worker releases the tenant row and hands the hint back', async () => {
    const harness = await createDurableTestHarness();
    for (const ddl of flowExecutionsDdl()
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean))
      await harness.spineDb.execute(sql.raw(ddl));
    const planes = {
      dataPlaneResolver: createSingleDataPlaneResolver(harness.tenantDb, {
        coreSchema: harness.coreSchema,
      }),
      frameworkSchema: harness.coreSchema,
    };
    const old = worker(harness.spineDb, registryOf(flow('existing', ['only'])), planes);
    const current = worker(harness.spineDb, registryOf(flow('added-later', ['only'])), planes);
    try {
      const started = await current.pool.flowEngine.start('added-later', {}, tenantAuth);
      await old.pool.start();
      await vi.waitFor(() => expect(old.unavailable).toHaveLength(1));
      await settle();
      expect(old.unavailable).toHaveLength(1);
      expect(old.unavailable[0]?.reason).toBe('flow-not-registered');

      // The tenant row is runnable again; the hint is ready and no attempt was spent.
      expect(await row(harness.tenantDb, started.id)).toEqual({
        status: 'running',
        lease_owner: null,
        lease_expired: true,
      });
      const hints = await harness.spineDb.execute<{ delivery_state: string; attempt: number }>(
        sql`SELECT delivery_state, attempt FROM opaque_dispatch WHERE execution_id = ${started.id}`,
      );
      expect([...hints]).toEqual([{ delivery_state: 'ready', attempt: 0 }]);

      await current.pool.start();
      await vi.waitFor(async () =>
        expect((await current.pool.flowEngine.status(started.id)).status).toBe('completed'),
      );
      expect(current.ran).toEqual(['testing.only']);
      expect(old.ran).toEqual([]);
    } finally {
      await stopAll(old, current);
      await harness.close();
    }
  }, 30_000);

  it('spine hints: a step missing from the live definition releases the tenant row and the hint', async () => {
    const harness = await createDurableTestHarness();
    for (const ddl of flowExecutionsDdl()
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean))
      await harness.spineDb.execute(sql.raw(ddl));
    const planes = {
      dataPlaneResolver: createSingleDataPlaneResolver(harness.tenantDb, {
        coreSchema: harness.coreSchema,
      }),
      frameworkSchema: harness.coreSchema,
    };
    const old = worker(harness.spineDb, registryOf(flow('evolving', ['first'])), planes);
    const current = worker(
      harness.spineDb,
      registryOf(flow('evolving', ['first', 'added'])),
      planes,
    );
    try {
      const started = await current.pool.flowEngine.start('evolving', {}, tenantAuth);
      await harness.tenantDb.execute(
        sql`UPDATE flow_executions SET current_step = 'added' WHERE id = ${started.id}`,
      );
      await old.pool.start();
      await vi.waitFor(() => expect(old.unavailable).toHaveLength(1));
      await settle();
      expect(old.unavailable.map((info) => info.reason)).toEqual(['step-not-found']);
      expect(await row(harness.tenantDb, started.id)).toMatchObject({
        status: 'running',
        lease_owner: null,
      });
      const hints = await harness.spineDb.execute<{ delivery_state: string }>(
        sql`SELECT delivery_state FROM opaque_dispatch WHERE execution_id = ${started.id}`,
      );
      expect([...hints]).toEqual([{ delivery_state: 'ready' }]);

      await current.pool.start();
      await vi.waitFor(async () =>
        expect((await current.pool.flowEngine.status(started.id)).status).toBe('completed'),
      );
      expect(current.ran).toEqual(['testing.added']);
      expect(old.ran).toEqual([]);
    } finally {
      await stopAll(old, current);
      await harness.close();
    }
  }, 30_000);
});
