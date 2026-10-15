// A flow start deferred to commit survives a crash between commit and start: the intent is
// written in the capability's transaction and a worker starts it, once, under the same id.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineCapability, defineFlow } from '../../define/index.js';
import {
  createDurableTestDatabase,
  createDurableTestHarness,
  flowExecutionsDdl,
} from '../../durable/index.js';
import { ConsumerRegistry, createInMemoryQueue } from '../../events/index.js';
import { executeCapability } from '../../execution/capability-executor.js';
import { createTransactionRunner } from '../../execution/transactional-outbox.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import { createTestContext } from '../../testing/context.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { ExecutionContext } from '../../types/context.js';
import { FlowStepType } from '../../types/enums.js';
import { createWorkerPool } from '../../worker/index.js';
import { createFlowEngine } from '../engine.js';
import { createFlowService } from '../flow-service.js';
import { FlowRegistry } from '../registry.js';
import { recoverFlowStartIntents } from '../start-intents.js';

const auth = { userId: 'u1', roles: ['admin'], scopes: [], provider: 'test' };

function registry(): FlowRegistry {
  const flows = new FlowRegistry();
  flows.register(
    defineFlow({
      name: 'intent-probe',
      domain: 'testing',
      input: z.object({ orderId: z.string() }),
      steps: [{ name: 'only', type: FlowStepType.Capability, capability: 'testing.only' }],
    }),
  );
  return flows;
}

const stepDeps = {
  async executeCapability() {
    return { success: true, data: {} };
  },
  evaluateCondition: () => true,
};

/** An action that writes a business row and starts a flow in its transaction. */
const placeOrder = defineCapability({
  name: 'placeOrder',
  kind: 'action',
  domain: 'testing',
  input: z.object({ orderId: z.string(), fail: z.boolean().optional() }),
  output: z.object({ executionId: z.string() }),
  access: { roles: ['admin'] },
  effects: { data: ['orders'], events: [], external: [], ai: false },
  async handler(ctx, input) {
    const tx = ctx.__runtime?.transactionScope?.db;
    if (!tx) throw new Error('expected a transaction');
    await tx.execute(sql`INSERT INTO orders (id) VALUES (${input.orderId})`);
    const started = await ctx.flows.start('intent-probe' as never, { orderId: input.orderId });
    if (input.fail) throw new Error('rolled back');
    return { executionId: started.id };
  },
});

async function prepare(db: PostgresJsDatabase): Promise<void> {
  for (const ddl of flowExecutionsDdl()
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean))
    await db.execute(sql.raw(ddl));
  await db.execute(sql`CREATE TABLE orders (id text PRIMARY KEY)`);
}

/**
 * A request context whose transaction runner commits on `db`. `runDeferred: false` stands in
 * for a process that dies right after the commit, before any post-commit work.
 */
function capabilityContext(
  db: PostgresJsDatabase,
  engine: ReturnType<typeof createFlowEngine>,
  flows: FlowRegistry,
  options: { runDeferred: boolean },
): ExecutionContext {
  const runner = createTransactionRunner({
    db,
    entities: { createDataService: () => ({}) } as never,
    events: { get: () => undefined } as never,
    getAuth: () => auth,
    getAudit: () => ({ record: async () => undefined }) as never,
  });
  const withTransaction = options.runDeferred
    ? runner
    : async <T>(fn: (scope: Parameters<Parameters<typeof runner>[0]>[0]) => Promise<T>) =>
        db.transaction(async (tx) =>
          fn({
            data: {} as never,
            events: {} as never,
            db: tx as unknown as PostgresJsDatabase,
            planeDb: db,
            deferred: [],
          }),
        );
  const ctx = createTestContext({
    auth: { ...auth, tenantId: undefined },
    flows: createFlowService(engine, auth, flows),
  });
  return { ...ctx, __runtime: { ...ctx.__runtime, withTransaction } };
}

async function count(db: PostgresJsDatabase, table: 'flow_start_intents' | 'flow_executions') {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`,
  );
  return [...rows][0]?.n ?? 0;
}

describe('durable deferred flow start', () => {
  it('starts the flow after commit and leaves no intent behind', async () => {
    const database = await createDurableTestDatabase({ kind: 'intent_ok', ddl: '' });
    try {
      await prepare(database.db);
      const flows = registry();
      const engine = createFlowEngine({ db: database.db, registry: flows, stepDeps });
      const ctx = capabilityContext(database.db, engine, flows, { runDeferred: true });

      const result = await executeCapability(placeOrder, ctx, { orderId: 'o-1' });
      expect(result.success).toBe(true);
      const executionId = result.success ? result.data.executionId : '';
      expect((await engine.status(executionId)).status).toBe('created');
      expect(await count(database.db, 'flow_start_intents')).toBe(0);
    } finally {
      await database.close();
    }
  }, 30_000);

  it('writes nothing when the transaction rolls back', async () => {
    const database = await createDurableTestDatabase({ kind: 'intent_rollback', ddl: '' });
    try {
      await prepare(database.db);
      const flows = registry();
      const engine = createFlowEngine({ db: database.db, registry: flows, stepDeps });
      const ctx = capabilityContext(database.db, engine, flows, { runDeferred: true });

      const result = await executeCapability(placeOrder, ctx, { orderId: 'o-2', fail: true });
      expect(result.success).toBe(false);
      expect(await count(database.db, 'flow_start_intents')).toBe(0);
      expect(await count(database.db, 'flow_executions')).toBe(0);
    } finally {
      await database.close();
    }
  }, 30_000);

  it('recovers a start lost between commit and start, once, under the same execution id', async () => {
    const database = await createDurableTestDatabase({ kind: 'intent_crash', ddl: '' });
    try {
      await prepare(database.db);
      const flows = registry();
      const engine = createFlowEngine({ db: database.db, registry: flows, stepDeps });
      const crashed = capabilityContext(database.db, engine, flows, { runDeferred: false });

      const result = await executeCapability(placeOrder, crashed, { orderId: 'o-3' });
      const executionId = result.success ? result.data.executionId : '';
      // Committed: the order and the intent, but no execution.
      expect(await count(database.db, 'flow_executions')).toBe(0);
      const [intent] = [
        ...(await database.db.execute<{ due_later: boolean; auth_snapshot_json: unknown }>(sql`
          SELECT next_attempt_at > now() AS due_later, auth_snapshot_json
          FROM flow_start_intents WHERE execution_id = ${executionId}
        `)),
      ];
      expect(intent).toMatchObject({ due_later: true, auth_snapshot_json: { userId: 'u1' } });

      // Not due yet: the grace period belongs to the post-commit start.
      const start = vi.fn((i: { flowName: string; input: unknown; executionId: string }) =>
        engine.start(i.flowName, i.input, auth, { executionId: i.executionId }),
      );
      expect(await recoverFlowStartIntents({ db: database.db, start })).toBe(0);

      await database.db.execute(sql`UPDATE flow_start_intents SET next_attempt_at = now()`);
      // Two workers recover concurrently: SKIP LOCKED gives the intent to one of them.
      const recovered = await Promise.all([
        recoverFlowStartIntents({ db: database.db, start }),
        recoverFlowStartIntents({ db: database.db, start }),
      ]);
      expect(recovered.sort()).toEqual([0, 1]);
      expect(start).toHaveBeenCalledTimes(1);
      expect(await count(database.db, 'flow_start_intents')).toBe(0);
      const rows = await database.db.execute<{ id: string; actor: string }>(
        sql`SELECT id, actor FROM flow_executions`,
      );
      expect([...rows]).toEqual([{ id: executionId, actor: 'u1' }]);
    } finally {
      await database.close();
    }
  }, 30_000);

  it('keeps an intent whose start fails and retries it later; a late duplicate start is a no-op', async () => {
    const database = await createDurableTestDatabase({ kind: 'intent_retry', ddl: '' });
    try {
      await prepare(database.db);
      const flows = registry();
      const engine = createFlowEngine({ db: database.db, registry: flows, stepDeps });
      const crashed = capabilityContext(database.db, engine, flows, { runDeferred: false });
      const result = await executeCapability(placeOrder, crashed, { orderId: 'o-4' });
      const executionId = result.success ? result.data.executionId : '';
      await database.db.execute(sql`UPDATE flow_start_intents SET next_attempt_at = now()`);

      // A worker without the flow (an older release) cannot start it: the intent stays.
      const unavailable = vi.fn(async () => {
        throw new Error('Flow "intent-probe" is not registered');
      });
      expect(await recoverFlowStartIntents({ db: database.db, start: unavailable })).toBe(0);
      const [kept] = [
        ...(await database.db.execute<{ attempts: number; last_error: string; backoff: boolean }>(
          sql`SELECT attempts, last_error, next_attempt_at > now() AS backoff FROM flow_start_intents`,
        )),
      ];
      expect(kept).toEqual({
        attempts: 1,
        last_error: 'Flow "intent-probe" is not registered',
        backoff: true,
      });

      // The post-commit start ran after all (slow, not dead): recovery finds it started.
      await engine.start('intent-probe', { orderId: 'o-4' }, auth, { executionId });
      await database.db.execute(sql`UPDATE flow_start_intents SET next_attempt_at = now()`);
      const start = (i: { flowName: string; input: unknown; executionId: string }) =>
        engine.start(i.flowName, i.input, auth, { executionId: i.executionId });
      expect(await recoverFlowStartIntents({ db: database.db, start })).toBe(1);
      expect(await count(database.db, 'flow_executions')).toBe(1);
      expect(await count(database.db, 'flow_start_intents')).toBe(0);
    } finally {
      await database.close();
    }
  }, 30_000);

  it('drops an intent whose input the flow refuses', async () => {
    const database = await createDurableTestDatabase({ kind: 'intent_invalid', ddl: '' });
    try {
      await prepare(database.db);
      const flows = registry();
      const engine = createFlowEngine({ db: database.db, registry: flows, stepDeps });
      await database.db.execute(sql`
        INSERT INTO flow_start_intents (execution_id, flow_name, input, auth_snapshot_json, next_attempt_at)
        VALUES (gen_random_uuid(), 'intent-probe', '{"orderId": 7}', ${JSON.stringify(auth)}::jsonb, now())
      `);
      const start = (i: { flowName: string; input: unknown; executionId: string }) =>
        engine.start(i.flowName, i.input, auth, { executionId: i.executionId });
      expect(await recoverFlowStartIntents({ db: database.db, start })).toBe(0);
      expect(await count(database.db, 'flow_start_intents')).toBe(0);
      expect(await count(database.db, 'flow_executions')).toBe(0);
    } finally {
      await database.close();
    }
  }, 30_000);

  it('falls back to the plain post-commit start on a database without the intents table', async () => {
    const database = await createDurableTestDatabase({ kind: 'intent_unmigrated', ddl: '' });
    try {
      await prepare(database.db);
      await database.db.execute(sql`DROP TABLE flow_start_intents`);
      const flows = registry();
      const engine = createFlowEngine({ db: database.db, registry: flows, stepDeps });
      const ctx = capabilityContext(database.db, engine, flows, { runDeferred: true });
      const result = await executeCapability(placeOrder, ctx, { orderId: 'o-5' });
      expect(result.success).toBe(true);
      expect(await count(database.db, 'flow_executions')).toBe(1);
    } finally {
      await database.close();
    }
  }, 30_000);

  it('a worker pool recovers an intent left on a tenant plane and runs the flow there', async () => {
    const harness = await createDurableTestHarness();
    try {
      await harness.tenantDb.execute(sql`CREATE TABLE orders (id text PRIMARY KEY)`);
      const flows = registry();
      const tenantAuth = { ...auth, tenantId: 'tenant-a' };
      // The intent a request on the tenant plane wrote before its process died.
      await harness.tenantDb.execute(sql`
        INSERT INTO flow_start_intents (execution_id, flow_name, input, auth_snapshot_json, next_attempt_at)
        VALUES ('7a7a7a7a-0000-4000-8000-000000000001', 'intent-probe', '{"orderId": "o-6"}',
                ${JSON.stringify(tenantAuth)}::jsonb, now())
      `);
      const ran: string[] = [];
      const pool = createWorkerPool({
        config: { environment: 'test', database: harness.admin } as PlumbusConfig,
        db: harness.spineDb,
        flows,
        consumers: new ConsumerRegistry(),
        queue: createInMemoryQueue(),
        audit: { record: async () => {} },
        dataPlaneResolver: createSingleDataPlaneResolver(harness.tenantDb, {
          coreSchema: harness.coreSchema,
        }),
        listTenantRefs: async () => ['tenant-a'],
        frameworkSchema: harness.coreSchema,
        enableScheduler: false,
        enableDispatcher: false,
        enableEventWorker: false,
        flowPollIntervalMs: 20,
        flowStartRecoveryIntervalMs: 50,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        stepDeps: {
          async executeCapability(_name, ctx) {
            ran.push(`${ctx.flowId}:${ctx.auth.tenantId}`);
            return { success: true, data: {} };
          },
          evaluateCondition: () => true,
        },
      });
      // The spine needs flow_executions too: the pool's own claim loop reads it.
      for (const ddl of flowExecutionsDdl()
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean))
        await harness.spineDb.execute(sql.raw(ddl));
      await pool.start();
      try {
        await vi.waitFor(
          async () => {
            const status = await pool.flowEngine.status('7a7a7a7a-0000-4000-8000-000000000001');
            expect(status.status).toBe('completed');
          },
          { timeout: 10_000 },
        );
      } finally {
        await pool.stop();
      }
      expect(ran).toEqual(['7a7a7a7a-0000-4000-8000-000000000001:tenant-a']);
      expect(await count(harness.tenantDb, 'flow_start_intents')).toBe(0);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
