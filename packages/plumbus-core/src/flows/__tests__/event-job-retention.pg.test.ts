// Framework retention of the event and job tables against real Postgres (core 0.9.0-beta.15):
// `event_outbox`, `event_idempotency`, `event_dead_letter` and `job_executions`. What each class
// deletes, that it never selects a row that is not terminal or not past its period (every
// status at every age), that idempotency rows outlive any redelivery this database can make,
// that a class without its index is skipped, the batch bounds, the plans, and the worker pool
// running the classes on the pool database and a tenant plane.

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  createDurableTestHarness,
  type DurableTestHarness,
  eventDeliveryDdl,
  eventOutboxDdl,
  jobExecutionsDdl,
} from '../../durable/index.js';
import {
  ConsumerRegistry,
  createInMemoryQueue,
  EventDeadLetterResolution,
  resolveEventDeadLetter,
} from '../../events/index.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import type { PlumbusConfig } from '../../types/config.js';
import { createWorkerPool } from '../../worker/index.js';
import { FlowRegistry } from '../registry.js';
import { pruneFrameworkTables, resolveFrameworkRetentionOptions } from '../retention.js';

const OLD = 40;
const RECENT = 1;
const ALL_CLASSES = {
  eventOutbox: true,
  eventIdempotency: true,
  eventDeadLetter: true,
  jobExecutions: true,
} as const;

async function applyDdl(db: PostgresJsDatabase, ddl: string): Promise<void> {
  for (const statement of ddl
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean))
    await db.execute(sql.raw(statement));
}

async function withHarness(body: (harness: DurableTestHarness) => Promise<void>): Promise<void> {
  const harness = await createDurableTestHarness({
    includeEventOutbox: true,
    includeEventDelivery: true,
  });
  try {
    await applyDdl(harness.tenantDb, jobExecutionsDdl());
    await body(harness);
  } finally {
    await harness.close();
  }
}

const ago = (days: number) => sql`now() - make_interval(days => ${days})`;

async function outbox(db: PostgresJsDatabase, status: string, days: number): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO event_outbox (event_type, payload, actor, correlation_id, status, occurred_at, dispatched_at)
    VALUES ('probe.happened', '{}'::jsonb, 'tester', 'corr', ${status}, ${ago(days)},
            ${status === 'pending' ? null : ago(days)})
    RETURNING id::text
  `);
  return String([...rows][0]?.id);
}

async function processed(
  db: PostgresJsDatabase,
  eventId: string,
  days: number,
  consumerId = 'consumer-1',
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO event_idempotency (event_id, consumer_id, processed_at)
    VALUES (${eventId}, ${consumerId}, ${ago(days)})
    RETURNING id::text
  `);
  return String([...rows][0]?.id);
}

async function deadLetter(
  db: PostgresJsDatabase,
  eventId: string,
  options: { failedDays: number; resolvedDays?: number },
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO event_dead_letter (event_id, event_type, payload, consumer_id, retry_count, failed_at, metadata)
    VALUES (${eventId}, 'probe.happened', '{}'::jsonb, 'consumer-2', '3', ${ago(options.failedDays)},
      ${
        options.resolvedDays === undefined
          ? sql`'{"reason":"exhausted"}'::jsonb`
          : sql`jsonb_build_object('reason', 'exhausted', 'resolution', 'retried', 'resolvedAt',
              to_char((${ago(options.resolvedDays)}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`
      })
    RETURNING id::text
  `);
  return String([...rows][0]?.id);
}

async function job(
  db: PostgresJsDatabase,
  status: string,
  days: number,
  options: { dispatchPending?: boolean } = {},
): Promise<string> {
  const finished = ['completed', 'failed', 'dead_lettered'].includes(status);
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO job_executions (id, capability_domain, capability_name, status, dispatch_pending, created_at, started_at, completed_at)
    VALUES (gen_random_uuid(), 'probe', 'work', ${status}, ${options.dispatchPending ?? false},
            ${ago(days + 1)}, ${status === 'queued' ? null : ago(days)}, ${finished ? ago(days) : null})
    RETURNING id::text
  `);
  return String([...rows][0]?.id);
}

async function ids(db: PostgresJsDatabase, table: string): Promise<string[]> {
  return [...(await db.execute<{ id: string }>(sql.raw(`SELECT id::text AS id FROM ${table}`)))]
    .map((row) => String(row.id))
    .sort();
}

describe('event and job retention classes', () => {
  it('are off unless set, take keepDays by default, and validate', () => {
    expect(resolveFrameworkRetentionOptions(true)).toEqual({
      keepDays: 30,
      batchSize: 500,
      maxBatchesPerTable: 20,
      intervalMs: 3_600_000,
    });
    expect(
      resolveFrameworkRetentionOptions({
        keepDays: 30,
        eventOutbox: true,
        eventIdempotency: { keepDays: 45 },
        eventDeadLetter: {},
        jobExecutions: false,
      }),
    ).toEqual({
      keepDays: 30,
      batchSize: 500,
      maxBatchesPerTable: 20,
      intervalMs: 3_600_000,
      eventOutbox: { keepDays: 30 },
      eventIdempotency: { keepDays: 45 },
      eventDeadLetter: { keepDays: 30 },
    });
    expect(() => resolveFrameworkRetentionOptions({ eventOutbox: { keepDays: 0 } })).toThrow(
      /eventOutbox/,
    );
    expect(() =>
      resolveFrameworkRetentionOptions({ jobExecutions: 'yes' } as unknown as { keepDays: 1 }),
    ).toThrow(/jobExecutions/);
  });

  it('never selects a row that is not terminal or not past its period (every status at every age)', async () => {
    await withHarness(async ({ tenantDb }) => {
      const keep: Record<string, string[]> = { outbox: [], jobs: [] };
      const gone: Record<string, string[]> = { outbox: [], jobs: [] };
      for (const days of [OLD, 29, RECENT]) {
        for (const status of ['pending', 'processing', 'retry', 'dead_lettered', 'dispatched']) {
          const id = await outbox(tenantDb, status, days);
          (status === 'dispatched' && days > 30 ? gone : keep).outbox?.push(id);
        }
        for (const status of ['queued', 'running', 'completed', 'failed', 'dead_lettered']) {
          const id = await job(tenantDb, status, days);
          const finished = ['completed', 'failed', 'dead_lettered'].includes(status);
          (finished && days > 30 ? gone : keep).jobs?.push(id);
        }
      }
      // Finished long ago but its publication is still pending: kept.
      keep.jobs?.push(await job(tenantDb, 'failed', OLD, { dispatchPending: true }));

      const result = await pruneFrameworkTables(tenantDb, { keepDays: 30, ...ALL_CLASSES });
      expect(result).toMatchObject({
        eventOutbox: gone.outbox?.length,
        jobExecutions: gone.jobs?.length,
        drained: true,
      });
      expect(result.missingIndexes).toBeUndefined();
      expect(await ids(tenantDb, 'event_outbox')).toEqual([...(keep.outbox ?? [])].sort());
      expect(await ids(tenantDb, 'job_executions')).toEqual([...(keep.jobs ?? [])].sort());
    });
  });

  it('deletes resolved dead letters past their period and never an unresolved one', async () => {
    await withHarness(async ({ tenantDb }) => {
      const unresolvedOld = await deadLetter(tenantDb, 'e-1', { failedDays: 400 });
      const resolvedOld = await deadLetter(tenantDb, 'e-2', { failedDays: 400, resolvedDays: OLD });
      // Failed long ago, resolved yesterday: the period counts from the resolution.
      const resolvedRecent = await deadLetter(tenantDb, 'e-3', {
        failedDays: 400,
        resolvedDays: RECENT,
      });
      const result = await pruneFrameworkTables(tenantDb, { keepDays: 30, eventDeadLetter: true });
      expect(result.eventDeadLetters).toBe(1);
      expect(await ids(tenantDb, 'event_dead_letter')).toEqual(
        [unresolvedOld, resolvedRecent].sort(),
      );
      expect(resolvedOld).not.toBe(unresolvedOld);
    });
  });

  it('keeps an idempotency row while its event can still be delivered again from this database', async () => {
    await withHarness(async ({ tenantDb }) => {
      // Outbox rows the pump or a replay could publish again (any status keeps them).
      const pendingEvent = await outbox(tenantDb, 'pending', OLD);
      const dispatchedRecent = await outbox(tenantDb, 'dispatched', RECENT);
      const dispatchedOld = await outbox(tenantDb, 'dispatched', OLD);
      const keptForOutbox = [
        await processed(tenantDb, pendingEvent, OLD),
        await processed(tenantDb, dispatchedRecent, OLD),
      ];
      // Its outbox row goes in this same pass, so its idempotency row may go too.
      const afterOutbox = await processed(tenantDb, dispatchedOld, OLD);
      // An unresolved dead letter of the event: a retry republishes it to every consumer.
      const keptForDeadLetter = await processed(tenantDb, 'evt-dead', OLD);
      await deadLetter(tenantDb, 'evt-dead', { failedDays: OLD });
      // A resolved one does not hold it.
      const resolvedDeadLetter = await processed(tenantDb, 'evt-settled', OLD);
      await deadLetter(tenantDb, 'evt-settled', { failedDays: OLD, resolvedDays: RECENT });
      // No outbox row here (a job envelope, or an event from elsewhere; not a UUID either).
      const noOutbox = await processed(tenantDb, 'not-a-uuid', OLD);
      const young = await processed(tenantDb, 'evt-young', RECENT);

      const result = await pruneFrameworkTables(tenantDb, {
        keepDays: 30,
        eventOutbox: true,
        eventIdempotency: true,
      });
      expect(result).toMatchObject({ eventOutbox: 1, eventIdempotency: 3 });
      expect(await ids(tenantDb, 'event_idempotency')).toEqual(
        [...keptForOutbox, keptForDeadLetter, young].sort(),
      );
      expect([afterOutbox, resolvedDeadLetter, noOutbox]).toHaveLength(3);
    });
  });

  it('gives each class its own period', async () => {
    await withHarness(async ({ tenantDb }) => {
      const outboxRow = await outbox(tenantDb, 'dispatched', OLD);
      await job(tenantDb, 'completed', OLD);
      const result = await pruneFrameworkTables(tenantDb, {
        keepDays: 30,
        eventOutbox: { keepDays: 60 },
        jobExecutions: true,
      });
      expect(result).toMatchObject({ eventOutbox: 0, jobExecutions: 1 });
      expect(await ids(tenantDb, 'event_outbox')).toEqual([outboxRow]);
      expect(await ids(tenantDb, 'job_executions')).toEqual([]);
    });
  });

  it('leaves the event and job tables alone when the classes are off', async () => {
    await withHarness(async ({ tenantDb }) => {
      await outbox(tenantDb, 'dispatched', OLD);
      await job(tenantDb, 'completed', OLD);
      await processed(tenantDb, 'evt', OLD);
      await deadLetter(tenantDb, 'evt-2', { failedDays: OLD, resolvedDays: OLD });
      const result = await pruneFrameworkTables(tenantDb, { keepDays: 30 });
      expect(Object.keys(result).sort()).toEqual([
        'dispatchOutbox',
        'drained',
        'durableExecutions',
        'flowExecutions',
        'scheduleTicks',
        'sideEffects',
        'spineHints',
      ]);
      for (const table of [
        'event_outbox',
        'job_executions',
        'event_idempotency',
        'event_dead_letter',
      ]) {
        expect(await ids(tenantDb, table)).toHaveLength(1);
      }
    });
  });

  it('skips a class whose index is missing instead of scanning its table, and says which', async () => {
    await withHarness(async ({ tenantDb }) => {
      await outbox(tenantDb, 'dispatched', OLD);
      await processed(tenantDb, 'evt', OLD);
      await job(tenantDb, 'completed', OLD);
      await tenantDb.execute(sql`DROP INDEX event_outbox_dispatched_idx`);
      await tenantDb.execute(sql`DROP INDEX event_dead_letter_unresolved_idx`);
      const result = await pruneFrameworkTables(tenantDb, { keepDays: 30, ...ALL_CLASSES });
      expect(result).toMatchObject({
        eventOutbox: 0,
        eventIdempotency: 0,
        jobExecutions: 1,
        missingIndexes: ['event_dead_letter_unresolved_idx', 'event_outbox_dispatched_idx'],
      });
      expect(await ids(tenantDb, 'event_outbox')).toHaveLength(1);
      expect(await ids(tenantDb, 'event_idempotency')).toHaveLength(1);
    });
  });

  it('deletes in bounded batches and reports a backlog', async () => {
    await withHarness(async ({ tenantDb }) => {
      for (let index = 0; index < 5; index += 1) await job(tenantDb, 'completed', OLD);
      const first = await pruneFrameworkTables(tenantDb, {
        keepDays: 30,
        jobExecutions: true,
        batchSize: 2,
        maxBatchesPerTable: 2,
      });
      expect(first).toMatchObject({ jobExecutions: 4, drained: false });
      const second = await pruneFrameworkTables(tenantDb, {
        keepDays: 30,
        jobExecutions: true,
        batchSize: 2,
        maxBatchesPerTable: 2,
      });
      expect(second).toMatchObject({ jobExecutions: 1, drained: true });
    });
  });

  it('marks a dead letter resolved once', async () => {
    await withHarness(async ({ tenantDb }) => {
      const id = await deadLetter(tenantDb, 'evt', { failedDays: 1 });
      expect(
        await resolveEventDeadLetter(tenantDb, id, {
          actor: 'operator-7',
          resolution: EventDeadLetterResolution.Retried,
          note: 'replayed after the fix',
        }),
      ).toBe(true);
      expect(await resolveEventDeadLetter(tenantDb, id, { actor: 'someone-else' })).toBe(false);
      const [row] = [
        ...(await tenantDb.execute<{ metadata: Record<string, unknown> }>(
          sql`SELECT metadata FROM event_dead_letter WHERE id = ${id}::uuid`,
        )),
      ];
      expect(row?.metadata).toMatchObject({
        reason: 'exhausted',
        resolvedBy: 'operator-7',
        resolution: 'retried',
        note: 'replayed after the fix',
      });
      expect(String(row?.metadata.resolvedAt)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      await expect(resolveEventDeadLetter(tenantDb, 'nope', { actor: 'x' })).rejects.toThrow(
        /UUID/,
      );
      await expect(resolveEventDeadLetter(tenantDb, id, { actor: ' ' })).rejects.toThrow(
        /resolution/,
      );
    });
  });

  it('serves every class from its index under a generic plan', async () => {
    await withHarness(async (harness) => {
      // A table as a long-running host has it: mostly finished rows of every age, a few live.
      await harness.tenantDb.execute(sql`
        INSERT INTO event_outbox (event_type, payload, actor, correlation_id, status, dispatched_at)
        SELECT 'probe', '{}'::jsonb, 'tester', 'c',
               CASE WHEN g % 100 = 0 THEN 'pending' ELSE 'dispatched' END,
               now() - make_interval(hours => g)
        FROM generate_series(1, 5000) g
      `);
      await harness.tenantDb.execute(sql`
        INSERT INTO event_idempotency (event_id, consumer_id, processed_at)
        SELECT 'e' || g, 'c', now() - make_interval(hours => g) FROM generate_series(1, 5000) g
      `);
      await harness.tenantDb.execute(sql`
        INSERT INTO event_dead_letter (event_id, event_type, payload, retry_count, metadata)
        SELECT 'e' || g, 'probe', '{}'::jsonb, '1',
               CASE WHEN g % 10 = 0 THEN '{}'::jsonb
                    ELSE jsonb_build_object('resolvedAt', to_char((now() - make_interval(hours => g)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
        FROM generate_series(1, 5000) g
      `);
      await harness.tenantDb.execute(sql`
        INSERT INTO job_executions (id, capability_domain, capability_name, status, completed_at)
        SELECT gen_random_uuid(), 'probe', 'work',
               CASE WHEN g % 100 = 0 THEN 'queued' ELSE 'completed' END,
               CASE WHEN g % 100 = 0 THEN NULL ELSE now() - make_interval(hours => g) END
        FROM generate_series(1, 5000) g
      `);
      await harness.tenantDb.execute(sql`ANALYZE`);
      const client = postgres({
        host: harness.admin.host,
        port: harness.admin.port,
        database: harness.tenantName,
        username: harness.admin.user,
        password: harness.admin.password,
        max: 1,
        onnotice: () => {},
      });
      const queries: string[] = [];
      const db = drizzle(client, { logger: { logQuery: (query) => queries.push(query) } });
      try {
        await pruneFrameworkTables(db, { keepDays: 30, ...ALL_CLASSES });
        const plans: Record<string, string> = {};
        for (const [table, index] of [
          ['event_outbox', 'event_outbox_dispatched_idx'],
          ['event_idempotency', 'event_idempotency_processed_idx'],
          ['event_dead_letter', 'event_dead_letter_resolved_idx'],
          ['job_executions', 'job_exec_finished_idx'],
        ] as const) {
          const query = queries.find((text) => text.includes(`DELETE FROM ${table}`));
          expect(query, table).toBeDefined();
          const plan = await client.unsafe(`EXPLAIN (GENERIC_PLAN) ${query ?? ''}`);
          plans[table] = plan.map((row) => String(row['QUERY PLAN'])).join('\n');
          expect(plans[table], table).toContain(index);
        }
        // The idempotency guards probe by key, not by scanning.
        expect(plans.event_idempotency).toContain('event_outbox_pkey');
        expect(plans.event_idempotency).toContain('event_dead_letter_unresolved_idx');
        expect(plans.event_idempotency).not.toContain('Seq Scan on event_dead_letter');
      } finally {
        await client.end({ timeout: 5 });
      }
    });
  });

  it('runs from the worker pool on the pool database and every listed tenant plane', async () => {
    await withHarness(async (harness) => {
      for (const ddl of [eventOutboxDdl(), eventDeliveryDdl(), jobExecutionsDdl()]) {
        await applyDdl(harness.spineDb, ddl);
      }
      await applyDdl(
        harness.spineDb,
        'CREATE TABLE flow_executions (id uuid PRIMARY KEY, status text NOT NULL, flow_name text, lease_owner text, lease_expires_at timestamptz, lease_token uuid, wait_kind text, replay_of uuid, schedule_id uuid, schedule_tick_id uuid, definition_version text, definition_digest text, updated_at timestamptz NOT NULL DEFAULT now())',
      );
      const tenantOutbox = await outbox(harness.tenantDb, 'dispatched', OLD);
      const spineJob = await job(harness.spineDb, 'completed', OLD);
      const keptSpineJob = await job(harness.spineDb, 'running', OLD);
      const pool = createWorkerPool({
        config: { environment: 'test', database: harness.admin } as PlumbusConfig,
        db: harness.spineDb,
        flows: new FlowRegistry(),
        consumers: new ConsumerRegistry(),
        queue: createInMemoryQueue(),
        audit: { record: async () => {} },
        dataPlaneResolver: createSingleDataPlaneResolver(harness.tenantDb, {
          coreSchema: harness.coreSchema,
        }),
        listTenantRefs: () => ['tenant-a'],
        frameworkSchema: harness.coreSchema,
        enableScheduler: false,
        enableDispatcher: false,
        enableEventWorker: false,
        flowPollIntervalMs: 60_000,
        frameworkRetention: {
          keepDays: 30,
          intervalMs: 50,
          eventOutbox: true,
          jobExecutions: true,
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        stepDeps: {
          async executeCapability() {
            return { success: true, data: {} };
          },
          evaluateCondition: () => true,
        },
      });
      await pool.start();
      try {
        await expect
          .poll(
            async () => ({
              tenantOutbox: await ids(harness.tenantDb, 'event_outbox'),
              spineJobs: await ids(harness.spineDb, 'job_executions'),
            }),
            { timeout: 10_000, interval: 50 },
          )
          .toEqual({ tenantOutbox: [], spineJobs: [keptSpineJob] });
      } finally {
        await pool.stop();
      }
      expect(tenantOutbox).not.toBe(spineJob);
    });
  }, 30_000);
});
