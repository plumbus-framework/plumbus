// A connection ceiling across every plane a pooled resolver opens (`maxTotalConnections`), on
// real PostgreSQL databases: the server never sees more connections than the ceiling, idle
// planes are closed to make room, a leased plane's connections are never taken, a full budget
// refuses with DataPlaneConnectionBudgetError after the wait, and per-pool session settings
// (`jit = off`) reach every session.
//
// Every database here is a plumbus_durable_test_* database this file creates and drops.

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlumbusError } from '../../errors/plumbus-error.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { resolveTestPostgresAdmin } from '../../durable/pg-env.js';
import { DataPlaneConnectionBudgetError } from '../connection-budget.js';
import { openDataPlaneConnection } from '../data-plane-connection.js';
import { createPooledDataPlaneResolver } from '../data-plane-resolver.js';
import type { PooledDataPlaneResolverOptions } from '../types.js';

const admin = resolveTestPostgresAdmin();
const APPLICATION = `plumbus_budget_${process.pid}`;
const databases: Array<{ name: string; close(): Promise<void> }> = [];
const refs: string[] = [];
let probe: postgres.Sql;

beforeAll(async () => {
  for (let i = 0; i < 3; i += 1) {
    const database = await createDurableTestDatabase({ admin, kind: 'budget', ddl: 'SELECT 1;' });
    databases.push(database);
    refs.push(database.name);
  }
  probe = postgres({
    host: admin.host,
    port: admin.port,
    database: admin.database,
    username: admin.user,
    password: admin.password,
    max: 1,
    onnotice: () => {},
  });
}, 120_000);

afterAll(async () => {
  await probe?.end({ timeout: 5 });
  for (const database of databases) await database.close();
}, 120_000);

async function serverConnections(): Promise<number> {
  const [row] = await probe`
    SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${APPLICATION}
  `;
  return Number(row?.n ?? 0);
}

function resolverFor(
  overrides: Partial<PooledDataPlaneResolverOptions<string>> = {},
  pool: { maxConnections?: number; idleTimeoutSeconds?: number; useBudget?: boolean } = {},
) {
  return createPooledDataPlaneResolver<string>({
    cacheSize: 3,
    maxTotalConnections: 3,
    connectionWaitMs: 300,
    describe: async (tenantRef) =>
      refs.includes(tenantRef) ? { connectionInfo: tenantRef } : null,
    connect: ({ descriptor, connectionBudget }) =>
      openDataPlaneConnection({
        target: {
          host: admin.host,
          port: admin.port,
          database: descriptor.connectionInfo,
          user: admin.user,
          password: admin.password,
        },
        maxConnections: pool.maxConnections ?? 3,
        idleTimeoutSeconds: pool.idleTimeoutSeconds ?? 30,
        applicationName: APPLICATION,
        sessionSettings: { jit: 'off' },
        ...(pool.useBudget === false ? {} : connectionBudget ? { connectionBudget } : {}),
      }),
    ...overrides,
  });
}

/** Hold `count` connections of a plane busy until `until` resolves. */
function holdConnections(db: any, count: number, until: Promise<void>): Promise<unknown>[] {
  return Array.from({ length: count }, () =>
    db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT 1`);
      await until;
    }),
  );
}

describe('maxTotalConnections', () => {
  it('never opens more server connections than the ceiling; a leased, busy plane is not taken', async () => {
    const resolver = resolverFor();
    const [a, b] = refs as [string, string];
    const leaseA = await resolver.acquire(a);
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const busy = holdConnections(leaseA.handle.db, 3, done);
    while ((await serverConnections()) < 3) await new Promise((r) => setTimeout(r, 20));

    // Plane b resolves (its verify probe needs a connection): no slot, a's plane is leased.
    const started = Date.now();
    const refused = await resolver.acquire(b).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DataPlaneConnectionBudgetError);
    expect((refused as PlumbusError).metadata).toMatchObject({
      reason: 'data-plane-connection-budget',
      httpStatus: 503,
      maxTotalConnections: 3,
      open: 3,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await serverConnections()).toBe(3);
    expect(resolver.stats().connections).toMatchObject({ max: 3, open: 3 });

    finish();
    await Promise.all(busy);
    leaseA.release();
    await resolver.close();
    expect(await serverConnections()).toBe(0);
  }, 60_000);

  it('closes the least recently used unleased plane to make room, then serves the next tenant', async () => {
    const resolver = resolverFor({ connectionWaitMs: 5_000 });
    const [a, b] = refs as [string, string];
    // a opens three connections and goes idle (no lease).
    const handleA = await resolver.resolve(a);
    await Promise.all(
      [1, 2, 3].map(() => handleA.db.transaction(async (tx) => tx.execute(sql`SELECT 1`))),
    );
    expect(await serverConnections()).toBe(3);

    const leaseB = await resolver.acquire(b);
    const [row] = (await leaseB.handle.db.execute(sql`SHOW jit`)) as unknown as Array<{
      jit: string;
    }>;
    expect(row?.jit).toBe('off');
    expect(await serverConnections()).toBeLessThanOrEqual(3);
    expect(resolver.stats().cached).toBe(1); // a was closed to make room
    leaseB.release();
    await resolver.close();
  }, 60_000);

  it('refuses a plane its connect opened outside the budget, and refuses a bad ceiling', async () => {
    const resolver = resolverFor({}, { useBudget: false });
    await expect(resolver.acquire(refs[0] as string)).rejects.toMatchObject({
      metadata: { reason: 'data-plane-connection-budget-unused' },
    });
    expect(await serverConnections()).toBe(0);
    await resolver.close();
    expect(() => resolverFor({ maxTotalConnections: 0 })).toThrow(/maxTotalConnections/);
  }, 60_000);
});

describe('openDataPlaneConnection sessionSettings', () => {
  it('sets them on every session and refuses unsafe names and duplicates', async () => {
    const opened = await openDataPlaneConnection({
      target: {
        host: admin.host,
        port: admin.port,
        database: refs[2] as string,
        user: admin.user,
        password: admin.password,
      },
      sessionSettings: { jit: false, work_mem: '8MB' },
    });
    const [row] = (await opened.db.execute(
      sql`SELECT current_setting('jit') AS jit, current_setting('work_mem') AS work_mem`,
    )) as unknown as Array<{ jit: string; work_mem: string }>;
    expect(row).toEqual({ jit: 'off', work_mem: '8MB' });
    await opened.close();

    const target = {
      host: admin.host,
      port: admin.port,
      database: refs[2] as string,
      user: admin.user,
    };
    for (const sessionSettings of [
      { 'jit; drop': 'off' },
      { user: 'other' },
      { jit: 'off\n' },
    ] as Record<string, string>[]) {
      await expect(openDataPlaneConnection({ target, sessionSettings })).rejects.toMatchObject({
        code: 'validation',
      });
    }
    await expect(
      openDataPlaneConnection({
        target,
        statementTimeoutMs: 1000,
        sessionSettings: { statement_timeout: 5 },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  }, 60_000);
});
