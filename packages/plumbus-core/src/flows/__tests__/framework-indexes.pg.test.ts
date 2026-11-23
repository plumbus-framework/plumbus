// Core 0.9.0-beta.15 framework-table indexes against real Postgres: the statements `plumbus
// migrate generate` writes, turned into a `-- plumbus:no-transaction` concurrent migration,
// build on populated tables through the runner; the operator's newest-first flow list reads
// `flow_exec_updated_idx` (#166); and the failed-flow sweep, once it has made a complete pass,
// reads only the failed executions updated since (`flow_exec_failed_idx`, #201) — before, it
// walked every failed execution kept on every pass.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../data/migration.js';
import {
  createDurableTestDatabase,
  flowExecutionsDdl,
  resolveTestPostgresAdmin,
} from '../../durable/index.js';
import { ConsumerRegistry, createInMemoryQueue } from '../../events/index.js';
import type { PlumbusConfig } from '../../types/config.js';
import { createWorkerPool } from '../../worker/index.js';
import { sweepFailedFlowsSince } from '../dead-letter.js';
import { FlowRegistry } from '../registry.js';
import {
  ADDED_FRAMEWORK_INDEXES,
  generatedIndexStatements,
  previousFrameworkSnapshot,
} from './framework-indexes-fixture.js';

const admin = resolveTestPostgresAdmin();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function database(kind: string, ddl: string) {
  const created = await createDurableTestDatabase({ admin, kind, ddl });
  cleanups.push(() => created.close());
  return created;
}

/** A second, recording connection to a test database. */
function recording(name: string) {
  const client = postgres({
    host: admin.host,
    port: admin.port,
    database: name,
    username: admin.user,
    password: admin.password,
    max: 1,
    onnotice: () => {},
  });
  cleanups.push(() => client.end({ timeout: 5 }));
  const queries: Array<{ query: string; params: unknown[] }> = [];
  const db = drizzle(client, {
    logger: { logQuery: (query, params) => queries.push({ query, params }) },
  });
  return { client, db, queries };
}

async function plan(client: postgres.Sql, query: string, params: unknown[] = []) {
  const rows = await client.unsafe(`EXPLAIN ${query}`, params as never[]);
  return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
}

/** Rows the plan's scans of `table` returned, from EXPLAIN ANALYZE. */
async function rowsRead(
  client: postgres.Sql,
  query: string,
  params: unknown[],
  table: string,
): Promise<number> {
  const [row] = await client.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, params as never[]);
  type Node = {
    'Relation Name'?: string;
    'Actual Rows'?: number;
    'Actual Loops'?: number;
    Plans?: Node[];
  };
  const root = (row?.['QUERY PLAN'] as Array<{ Plan: Node }>)[0]?.Plan;
  let total = 0;
  const walk = (node: Node | undefined) => {
    if (!node) return;
    if (node['Relation Name'] === table) {
      total += (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1);
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(root);
  return total;
}

describe('framework-table indexes', () => {
  it('build concurrently on populated tables from the generated statements, through the runner', async () => {
    const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
    const { previous } = await previousFrameworkSnapshot();
    const created = await database('fwidx', 'CREATE SCHEMA core_plumbus');
    // The framework tables as an app on the previous snapshot has them.
    for (const statement of await generateMigration(generateDrizzleJson({}), previous as never)) {
      await created.db.execute(sql.raw(statement));
    }
    await created.db.execute(sql`
      INSERT INTO flow_executions (flow_name, domain, status, input, actor)
      SELECT 'probe', 'testing', CASE WHEN g % 3 = 0 THEN 'failed' ELSE 'completed' END, '{}'::jsonb, 't'
      FROM generate_series(1, 3000) g
    `);
    await created.db.execute(sql`
      INSERT INTO event_outbox (event_type, payload, actor, correlation_id, status, dispatched_at)
      SELECT 'probe', '{}'::jsonb, 't', 'c', 'dispatched', now() FROM generate_series(1, 3000)
    `);
    // The documented edit: the directive, and CONCURRENTLY on every statement.
    const statements = (await generatedIndexStatements()).map((statement) =>
      statement.replace('CREATE INDEX IF NOT EXISTS', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS'),
    );
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-fwidx-'));
    cleanups.push(async () => fs.rmSync(folder, { recursive: true, force: true }));
    fs.mkdirSync(path.join(folder, 'meta'));
    fs.writeFileSync(
      path.join(folder, '0001_framework_indexes.sql'),
      `-- plumbus:no-transaction\n${statements.join('\n--> statement-breakpoint\n')}\n`,
    );
    fs.writeFileSync(
      path.join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        entries: [
          { idx: 0, version: '7', when: 1000, tag: '0001_framework_indexes', breakpoints: true },
        ],
      }),
    );
    const result = await applyMigrations({ db: created.db, migrationsFolder: folder });
    expect(result).toMatchObject({ applied: 1 });
    const indexes = await created.db.execute<{ name: string; valid: boolean }>(sql`
      SELECT c.relname AS name, i.indisvalid AS valid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ANY(${sql.param(Object.keys(ADDED_FRAMEWORK_INDEXES))}::text[])
    `);
    expect(Object.fromEntries([...indexes].map((row) => [row.name, row.valid]))).toEqual(
      Object.fromEntries(Object.keys(ADDED_FRAMEWORK_INDEXES).map((name) => [name, true])),
    );
    // Run again: nothing pending, nothing rebuilt.
    expect(await applyMigrations({ db: created.db, migrationsFolder: folder })).toMatchObject({
      applied: 0,
    });
  });

  it('serve the newest-first flow list from flow_exec_updated_idx (#166)', async () => {
    const created = await database('fwlist', flowExecutionsDdl());
    await created.db.execute(sql`
      INSERT INTO flow_executions (flow_name, domain, status, input, actor, updated_at)
      SELECT 'probe', 'testing',
             (ARRAY['completed','failed','waiting','cancelled'])[1 + g % 4], '{}'::jsonb, 't',
             now() - make_interval(secs => g)
      FROM generate_series(1, 5000) g
    `);
    await created.db.execute(sql`ANALYZE flow_executions`);
    const client = recording(created.name).client;
    const list =
      'SELECT id FROM flow_executions ORDER BY updated_at DESC, id DESC LIMIT 50 OFFSET 100';
    const withIndex = await plan(client, list);
    expect(withIndex).toContain('flow_exec_updated_idx');
    expect(withIndex).not.toContain('Sort');
    // Without it (the previous schema) the whole table is sorted.
    await created.db.execute(sql`DROP INDEX flow_exec_updated_idx`);
    expect(await plan(client, list)).toContain('Sort');
  });

  it('let the failed-flow sweep read only failed executions updated since its last complete pass (#201)', async () => {
    const created = await database('fwsweep', flowExecutionsDdl());
    // Steady state: thousands of failed executions kept, each already dead-lettered.
    await created.db.execute(sql`
      WITH failed AS (
        INSERT INTO flow_executions (flow_name, domain, status, input, actor, updated_at)
        SELECT 'probe', 'testing', 'failed', '{}'::jsonb, 't', now() - interval '2 days'
        FROM generate_series(1, 3000)
        RETURNING id
      )
      INSERT INTO flow_dead_letter (execution_id, flow_name, input)
      SELECT id::text, 'probe', '{}'::jsonb FROM failed
    `);
    await created.db.execute(sql`ANALYZE`);
    const { client, db, queries } = recording(created.name);

    expect(await sweepFailedFlowsSince(db)).toEqual({ found: 0, moved: 0 });
    const full = queries.at(-1);
    expect(await rowsRead(client, full?.query ?? '', full?.params ?? [], 'flow_executions')).toBe(
      3000,
    );

    const since = new Date(Date.now() - 5 * 60_000);
    expect(await sweepFailedFlowsSince(db, { updatedSince: since })).toEqual({
      found: 0,
      moved: 0,
    });
    const windowed = queries.at(-1);
    expect(windowed?.query).toContain('flow_exec');
    expect(await plan(client, windowed?.query ?? '', windowed?.params ?? [])).toContain(
      'flow_exec_failed_idx',
    );
    expect(
      await rowsRead(client, windowed?.query ?? '', windowed?.params ?? [], 'flow_executions'),
    ).toBe(0);

    // A failure whose dead letter was never written is still found in the window.
    const [fresh] = [
      ...(await created.db.execute<{ id: string }>(sql`
        INSERT INTO flow_executions (flow_name, domain, status, input, actor)
        VALUES ('probe', 'testing', 'failed', '{}'::jsonb, 't') RETURNING id::text
      `)),
    ];
    expect(await sweepFailedFlowsSince(db, { updatedSince: since })).toEqual({
      found: 1,
      moved: 1,
    });
    const moved = await created.db.execute(
      sql`SELECT 1 FROM flow_dead_letter WHERE execution_id = ${fresh?.id}`,
    );
    expect([...moved]).toHaveLength(1);
  });

  it('the worker pool sweeps through the window after its first complete pass', async () => {
    const created = await database('fwpool', flowExecutionsDdl());
    const { db, queries } = recording(created.name);
    const pool = createWorkerPool({
      config: { environment: 'test', database: admin } as PlumbusConfig,
      db,
      flows: new FlowRegistry(),
      consumers: new ConsumerRegistry(),
      queue: createInMemoryQueue(),
      audit: { record: async () => {} },
      enableScheduler: false,
      enableDispatcher: false,
      enableEventWorker: false,
      flowPollIntervalMs: 20,
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
      const sweeps = () =>
        queries.filter((entry) =>
          entry.query.includes('NOT EXISTS (SELECT 1 FROM "flow_dead_letter"'),
        );
      await expect.poll(() => sweeps().length, { timeout: 5_000 }).toBeGreaterThan(2);
      const [first, ...later] = sweeps();
      expect(first?.query).not.toContain('"updated_at" >=');
      for (const entry of later) expect(entry.query).toContain('"updated_at" >=');

      const [fresh] = [
        ...(await created.db.execute<{ id: string }>(sql`
          INSERT INTO flow_executions (flow_name, domain, status, input, actor)
          VALUES ('probe', 'testing', 'failed', '{}'::jsonb, 't') RETURNING id::text
        `)),
      ];
      await expect
        .poll(
          async () =>
            [
              ...(await created.db.execute(
                sql`SELECT 1 FROM flow_dead_letter WHERE execution_id = ${fresh?.id}`,
              )),
            ].length,
          { timeout: 5_000 },
        )
        .toBe(1);
    } finally {
      await pool.stop();
    }
  });
});
