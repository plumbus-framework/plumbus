// ── Jobs enqueued by flow steps, with and without per-unit data planes ──
//
// Job publication, the worker's pending-job recovery and the job consumer all read the pool's
// own database. A flow step on the pool may enqueue jobs; a flow step on a resolved tenant plane
// may not until the job pipeline is plane-aware: a transactional step would write the job intent
// on the plane where nothing publishes it (the job is silently lost), and a non-transactional one
// would run the job against the pool with the tenant's auth. Such a step fails loudly instead.

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { auditRecords } from '../../audit/schema.js';
import { loadConfig } from '../../config/index.js';
import { EntityRegistry } from '../../data/registry.js';
import { defineCapability } from '../../define/defineCapability.js';
import { defineFlow } from '../../define/defineFlow.js';
import { spineDispatchDdl, tenantDurableDdl } from '../../durable/apply-ddl.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { resolveTestPostgresAdmin } from '../../durable/pg-env.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { deadLetterTable, idempotencyTable, outboxTable } from '../../events/outbox.js';
import { createInMemoryQueue } from '../../events/queue.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import * as flowSchema from '../../flows/schema.js';
import { jobExecutionsTable } from '../../jobs/schema.js';
import { buildStepDeps } from '../../runtime/bootstrap.js';
import { createSingleDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import type { CapabilityContract, CapabilityEffects } from '../../types/capability.js';
import { createWorkerPool } from '../bootstrap.js';

const CORE_SCHEMA = 'core_plumbus';
const NO_JOB_QUEUE = 'Job queue not configured on this execution context';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

/** A disposable database with `ddl` plus the framework tables (flows, jobs, audit, events). */
async function database(kind: string, ddl: string) {
  const handle = await createDurableTestDatabase({ kind, ddl });
  closers.push(handle.close);
  const admin = resolveTestPostgresAdmin();
  const client = postgres({
    host: admin.host,
    port: admin.port,
    database: handle.name,
    username: admin.user,
    password: admin.password,
    max: 5,
    onnotice: () => {},
  });
  closers.push(() => client.end({ timeout: 5 }));
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({
      auditRecords,
      ...flowSchema,
      jobExecutionsTable,
      deadLetterTable,
      idempotencyTable,
      outboxTable,
    }),
  );
  for (const statement of statements) await client.unsafe(statement);
  return drizzle(client);
}

/** Run one `test.dispatch` flow whose step enqueues `test.job`; report what became of it. */
async function runDispatchFlow(options: { tenantPlane: boolean; effects: CapabilityEffects }) {
  const pool = await database('fjpool', options.tenantPlane ? spineDispatchDdl() : '');
  const tenant = options.tenantPlane
    ? await database('fjtenant', tenantDurableDdl(CORE_SCHEMA))
    : undefined;

  const jobRuns: unknown[] = [];
  const enqueueErrors: string[] = [];
  const job = defineCapability({
    name: 'job',
    domain: 'test',
    kind: 'job',
    input: z.object({ value: z.number() }),
    output: z.object({}),
    access: { roles: ['user'], tenantScoped: true },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async (ctx) => {
      jobRuns.push(ctx.auth.tenantId);
      return {};
    },
  });
  const startJob = defineCapability({
    name: 'startJob',
    domain: 'test',
    kind: 'action',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    access: { roles: ['user'], tenantScoped: true },
    effects: options.effects,
    handler: async (ctx) => {
      try {
        return { id: await ctx.jobs.enqueue('test.job', { value: 1 }) };
      } catch (error) {
        enqueueErrors.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  });
  const capabilities = new CapabilityRegistry();
  capabilities.registerAll([job, startJob] as unknown as CapabilityContract[]);
  const flows = new FlowRegistry();
  flows.register(
    defineFlow({
      name: 'dispatch',
      domain: 'test',
      input: z.object({}),
      steps: [{ name: 'enqueue', type: 'capability', capability: 'test.startJob' }],
    }),
  );
  const queue = createInMemoryQueue();
  const workers = createWorkerPool({
    config: loadConfig({ env: {} }),
    db: pool,
    queue,
    jobsQueue: queue,
    capabilities,
    entities: new EntityRegistry(),
    eventRegistry: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows,
    stepDeps: buildStepDeps(capabilities),
    ...(tenant
      ? {
          dataPlaneResolver: createSingleDataPlaneResolver(tenant, { coreSchema: CORE_SCHEMA }),
          frameworkSchema: CORE_SCHEMA,
        }
      : {}),
    enableScheduler: false,
    enableDispatcher: false,
    flowPollIntervalMs: 50,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const auth = {
    userId: 'user',
    roles: ['user'],
    scopes: [],
    provider: 'test',
    tenantId: 'tenant-a',
  };
  const execution = await workers.flowEngine.start('dispatch', {}, auth);
  await workers.start();
  let status = '';
  try {
    await vi.waitFor(
      async () => {
        status = (await workers.flowEngine.status(execution.id)).status;
        expect(['completed', 'failed']).toContain(status);
        // A completed flow's job must also have run before the rows are read.
        if (status === 'completed') expect(jobRuns).toHaveLength(1);
      },
      { timeout: 15_000, interval: 50 },
    );
  } finally {
    await workers.stop();
  }
  return {
    status,
    jobRuns,
    enqueueErrors,
    poolJobs: await pool.select().from(jobExecutionsTable),
    tenantJobs: tenant ? await tenant.select().from(jobExecutionsTable) : [],
  };
}

describe('jobs enqueued by flow steps', () => {
  it('run on the pool when the flow runs on the pool', async () => {
    const result = await runDispatchFlow({
      tenantPlane: false,
      effects: { data: [], events: [], external: [], ai: false },
    });

    expect(result.status).toBe('completed');
    expect(result.enqueueErrors).toEqual([]);
    expect(result.jobRuns).toEqual(['tenant-a']);
    expect(result.poolJobs).toMatchObject([
      { tenantId: 'tenant-a', status: 'completed', dispatchPending: false },
    ]);
  }, 60_000);

  it.each<[string, CapabilityEffects]>([
    ['a transactional step', { data: [], events: [], external: [], ai: false }],
    // An external effect turns the transactional outbox off for the step.
    ['a non-transactional step', { data: [], events: [], external: ['notifier'], ai: false }],
  ])(
    'fail %s on a resolved tenant plane instead of losing or misplacing the job',
    async (_name, effects) => {
      const result = await runDispatchFlow({ tenantPlane: true, effects });

      expect(result.status).toBe('failed');
      expect(result.enqueueErrors.length).toBeGreaterThan(0);
      expect(new Set(result.enqueueErrors)).toEqual(new Set([NO_JOB_QUEUE]));
      expect(result.jobRuns).toEqual([]);
      expect(result.tenantJobs).toEqual([]);
      expect(result.poolJobs).toEqual([]);
    },
    60_000,
  );
});
