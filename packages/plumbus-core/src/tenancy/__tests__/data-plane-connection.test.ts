// ── Opening a data plane, against a real cluster ──
//
// Every test here opens a real pooled connection to a real database that
// `provisionDataPlane` created moments earlier, as the least-privilege runtime
// role that provisioning created for it. What is being proven is that the
// framework can hand a host the `connect` step `createPooledDataPlaneResolver`
// requires: a named database, opened as a named role, bounded, closable, and
// silent about credentials when it refuses.
//
// These tests require a reachable Postgres with cluster-level rights and must
// FAIL — never silently pass — when one is not available. A green run has to
// mean sockets were opened, rows were read, and backends went away on close.

import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlumbusError } from '../../errors/plumbus-error.js';
import {
  DataPlaneConnectionError,
  MAX_DATA_PLANE_POOL_SIZE,
  openDataPlaneConnection,
} from '../data-plane-connection.js';
import { dropDataPlane, provisionDataPlane } from '../data-plane-provisioning.js';
import { createPooledDataPlaneResolver } from '../data-plane-resolver.js';

const admin = {
  host: process.env.PLUMBUS_TEST_PG_HOST ?? 'localhost',
  port: Number(process.env.PLUMBUS_TEST_PG_PORT ?? '5442'),
  database: process.env.PLUMBUS_TEST_PG_DATABASE ?? 'postgres',
  user: process.env.PLUMBUS_TEST_PG_USER ?? 'postgres',
  password: process.env.PLUMBUS_TEST_PG_PASSWORD ?? 'postgres',
};

/** The naming convention every fixture in this file obeys, and the drop guard. */
const FIXTURE_PATTERN = /^plumbus_test_dpc_[a-z0-9_]+$/;

const DB_TIMEOUT = 60_000;

interface DataPlaneFixture {
  /** Tenant reference the resolver test keys this data plane by. */
  tenantRef: string;
  database: string;
  owner: string;
  runtime: string;
  ownerPassword: string;
  runtimePassword: string;
  /** Written by the owner role, read back through the opened connection. */
  label: string;
}

const fixtures: DataPlaneFixture[] = [];

function newFixture(label: string): DataPlaneFixture {
  const suffix = `${label}_${randomBytes(4).toString('hex')}`;
  const fixture: DataPlaneFixture = {
    tenantRef: `tenant-${suffix}`,
    database: `plumbus_test_dpc_${suffix}`,
    owner: `plumbus_test_dpc_${suffix}_owner`,
    runtime: `plumbus_test_dpc_${suffix}_runtime`,
    ownerPassword: `owner-${suffix}`,
    runtimePassword: `runtime-${suffix}`,
    label,
  };
  fixtures.push(fixture);
  return fixture;
}

const primary = newFixture('primary');
const secondary = newFixture('secondary');

/** The table the owner role creates; the runtime role reaches it through default privileges. */
const PROBE_DDL = `
  CREATE TABLE connection_probe (
    id integer PRIMARY KEY,
    label text NOT NULL
  )
`;

/** A raw client, used only to set fixtures up and to observe the server directly. */
function rawConnect(options: { database: string; user: string; password: string }): postgres.Sql {
  return postgres({
    host: admin.host,
    port: admin.port,
    database: options.database,
    username: options.user,
    password: options.password,
    max: 2,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

/** Kept open for the whole file so backend counts are read from outside the pool under test. */
let observer: postgres.Sql | undefined;

function requireObserver(): postgres.Sql {
  if (!observer) throw new Error('The observing admin connection was never opened');
  return observer;
}

/** Server-side truth: how many backends this role holds against this database. */
async function backendCount(database: string, user: string): Promise<number> {
  const rows = await requireObserver()<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_catalog.pg_stat_activity
    WHERE datname = ${database} AND usename = ${user}
  `;
  return rows[0]?.count ?? 0;
}

/** Backends belonging to one opened connection, isolated from every other pool. */
async function backendCountByApplication(applicationName: string): Promise<number> {
  const rows = await requireObserver()<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_catalog.pg_stat_activity
    WHERE application_name = ${applicationName}
  `;
  return rows[0]?.count ?? 0;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backends disappear a moment after the client closes its sockets, so the count
 * is polled rather than sampled once. Returns the last count observed, which the
 * caller asserts on — a timeout must fail the test, not pass it.
 */
async function waitForBackendCount(
  database: string,
  user: string,
  expected: number,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = await backendCount(database, user);
  while (count !== expected && Date.now() < deadline) {
    await delay(100);
    count = await backendCount(database, user);
  }
  return count;
}

/** The runtime credentials a host would hand the framework for this tenant. */
function runtimeTarget(fixture: DataPlaneFixture) {
  return {
    host: admin.host,
    port: admin.port,
    database: fixture.database,
    user: fixture.runtime,
    password: fixture.runtimePassword,
  };
}

/**
 * Runs `concurrency` transactions at once against one data plane and reports how
 * many server backends the pool actually held while they ran. Each transaction
 * reserves a connection, so the count is the pool's real width.
 */
async function backendsUnderLoad(
  fixture: DataPlaneFixture,
  maxConnections: number,
  concurrency: number,
): Promise<number> {
  const applicationName = `plumbus-pool-${randomBytes(4).toString('hex')}`;
  const connection = await openDataPlaneConnection({
    target: runtimeTarget(fixture),
    maxConnections,
    applicationName,
  });
  try {
    const inFlight = Array.from({ length: concurrency }, () =>
      connection.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(0.5)`);
      }),
    );
    await delay(300);
    const observed = await backendCountByApplication(applicationName);
    await Promise.all(inFlight);
    return observed;
  } finally {
    await connection.close();
  }
}

async function currentDatabase(db: PostgresJsDatabase): Promise<string> {
  const rows = await db.execute<{ database: string; role: string }>(
    sql`SELECT current_database() AS database, current_user AS role`,
  );
  return String(rows[0]?.database);
}

async function setUpFixture(fixture: DataPlaneFixture): Promise<void> {
  await provisionDataPlane({
    adminConnection: admin,
    databaseName: fixture.database,
    ownerRole: { name: fixture.owner, password: fixture.ownerPassword },
    runtimeRole: { name: fixture.runtime, password: fixture.runtimePassword },
    namePattern: FIXTURE_PATTERN,
  });

  const owner = rawConnect({
    database: fixture.database,
    user: fixture.owner,
    password: fixture.ownerPassword,
  });
  try {
    await owner.unsafe(PROBE_DDL);
    await owner`INSERT INTO connection_probe (id, label) VALUES (1, ${fixture.label})`;
  } finally {
    await owner.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  observer = rawConnect(admin);
  // Fails the whole file loudly when the cluster is unreachable or under-privileged.
  await observer`SELECT 1`;
  for (const fixture of fixtures) {
    await setUpFixture(fixture);
  }
}, DB_TIMEOUT);

afterAll(async () => {
  for (const fixture of fixtures) {
    await dropDataPlane({
      adminConnection: admin,
      databaseName: fixture.database,
      roles: [fixture.owner, fixture.runtime],
      allowedNamePattern: FIXTURE_PATTERN,
    }).catch(() => undefined);
  }
  await observer?.end({ timeout: 5 }).catch(() => undefined);
  observer = undefined;
}, DB_TIMEOUT);

describe('openDataPlaneConnection — refusals before a socket is opened', () => {
  it('refuses a pool size outside the bound', async () => {
    for (const maxConnections of [0, -1, 1.5, MAX_DATA_PLANE_POOL_SIZE + 1, Number.NaN]) {
      const error = await openDataPlaneConnection({
        target: runtimeTarget(primary),
        maxConnections,
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(PlumbusError);
      expect((error as PlumbusError).code).toBe('validation');
      expect((error as PlumbusError).metadata?.field).toBe('maxConnections');
    }
  });

  it('refuses a target that names no database, role or host', async () => {
    for (const target of [
      { host: admin.host, database: '', user: 'someone' },
      { host: admin.host, database: 'somewhere', user: '' },
      { host: '', database: 'somewhere', user: 'someone' },
    ]) {
      const error = await openDataPlaneConnection({ target }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(PlumbusError);
      expect((error as PlumbusError).code).toBe('validation');
    }
  });

  it('refuses a connection parameter carrying a NUL', async () => {
    const error = await openDataPlaneConnection({
      target: { ...runtimeTarget(primary), database: `${primary.database}\u0000extra` },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PlumbusError);
    expect((error as PlumbusError).code).toBe('validation');
    expect((error as PlumbusError).message).toContain('NUL');
  });

  it('refuses a connection string that is not a postgres URL', async () => {
    const error = await openDataPlaneConnection({
      target: { connectionString: 'mysql://user:pw@localhost:3306/db' },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PlumbusError);
    expect((error as PlumbusError).code).toBe('validation');
  });

  it('refuses an out-of-range timeout', async () => {
    const error = await openDataPlaneConnection({
      target: runtimeTarget(primary),
      connectTimeoutSeconds: 0,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PlumbusError);
    expect((error as PlumbusError).metadata?.field).toBe('connectTimeoutSeconds');
  });
});

describe('openDataPlaneConnection — against a provisioned data plane', () => {
  it(
    'opens the named database as the named role and answers a query',
    async () => {
      const connection = await openDataPlaneConnection({ target: runtimeTarget(primary) });
      try {
        const rows = await connection.db.execute<{ database: string; role: string }>(
          sql`SELECT current_database() AS database, current_user AS role`,
        );
        expect(rows[0]?.database).toBe(primary.database);
        expect(rows[0]?.role).toBe(primary.runtime);
      } finally {
        await connection.close();
      }
    },
    DB_TIMEOUT,
  );

  it(
    'reads the rows the owner role wrote, through the privileges provisioning granted',
    async () => {
      const connection = await openDataPlaneConnection({ target: runtimeTarget(primary) });
      try {
        const rows = await connection.db.execute<{ label: string }>(
          sql`SELECT label FROM connection_probe ORDER BY id`,
        );
        expect(rows.map((row) => row.label)).toEqual([primary.label]);
      } finally {
        await connection.close();
      }
    },
    DB_TIMEOUT,
  );

  it(
    'accepts a connection string target',
    async () => {
      const connectionString =
        `postgres://${encodeURIComponent(primary.runtime)}:` +
        `${encodeURIComponent(primary.runtimePassword)}@${admin.host}:${admin.port}/${primary.database}`;
      const connection = await openDataPlaneConnection({ target: { connectionString } });
      try {
        expect(await currentDatabase(connection.db)).toBe(primary.database);
      } finally {
        await connection.close();
      }
    },
    DB_TIMEOUT,
  );

  it(
    'holds no more backends than the pool ceiling allows',
    async () => {
      // Six concurrent transactions, because each one reserves a connection for
      // its duration — plain queries would be pipelined down a single socket and
      // would prove nothing about the ceiling.
      const narrow = await backendsUnderLoad(primary, 2, 6);
      const wide = await backendsUnderLoad(primary, 4, 6);

      expect(narrow).toBe(2);
      // The control: the same workload really does want more than two
      // connections, so the ceiling above is what held it to two.
      expect(wide).toBe(4);
    },
    DB_TIMEOUT,
  );

  it(
    'closes the pool, releases every backend, and refuses further work',
    async () => {
      const applicationName = `plumbus-close-${randomBytes(3).toString('hex')}`;
      const connection = await openDataPlaneConnection({
        target: runtimeTarget(primary),
        maxConnections: 3,
        applicationName,
      });
      const inFlight = Array.from({ length: 3 }, () =>
        connection.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_sleep(0.5)`);
        }),
      );
      await delay(300);
      expect(await backendCountByApplication(applicationName)).toBe(3);
      await Promise.all(inFlight);

      await connection.close();

      expect(await waitForBackendCount(primary.database, primary.runtime, 0)).toBe(0);
      await expect(connection.db.execute(sql`SELECT 1`)).rejects.toBeInstanceOf(Error);
    },
    DB_TIMEOUT,
  );

  it(
    'closes idempotently',
    async () => {
      const connection = await openDataPlaneConnection({ target: runtimeTarget(primary) });
      await connection.close();
      await expect(connection.close()).resolves.toBeUndefined();
      await expect(connection.close()).resolves.toBeUndefined();
    },
    DB_TIMEOUT,
  );

  it(
    'is safe to call once per tenant: two data planes stay independent',
    async () => {
      const [first, second] = await Promise.all([
        openDataPlaneConnection({ target: runtimeTarget(primary), maxConnections: 2 }),
        openDataPlaneConnection({ target: runtimeTarget(secondary), maxConnections: 2 }),
      ]);
      try {
        expect(await currentDatabase(first.db)).toBe(primary.database);
        expect(await currentDatabase(second.db)).toBe(secondary.database);

        const firstLabels = await first.db.execute<{ label: string }>(
          sql`SELECT label FROM connection_probe`,
        );
        const secondLabels = await second.db.execute<{ label: string }>(
          sql`SELECT label FROM connection_probe`,
        );
        expect(firstLabels.map((row) => row.label)).toEqual([primary.label]);
        expect(secondLabels.map((row) => row.label)).toEqual([secondary.label]);

        // Closing one tenant's pool leaves the other's untouched.
        await first.close();
        expect(await waitForBackendCount(primary.database, primary.runtime, 0)).toBe(0);
        expect(await currentDatabase(second.db)).toBe(secondary.database);
      } finally {
        await first.close();
        await second.close();
      }
    },
    DB_TIMEOUT,
  );
});

describe('openDataPlaneConnection — refusals from the server', () => {
  it(
    'refuses a wrong credential and keeps it out of the error',
    async () => {
      const password = `wrong-${randomBytes(8).toString('hex')}`;
      const error = await openDataPlaneConnection({
        target: { ...runtimeTarget(primary), password },
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(DataPlaneConnectionError);
      const failure = error as DataPlaneConnectionError;
      expect(failure.metadata?.sqlState).toBe('28P01');
      expect(failure.metadata?.database).toBe(primary.database);
      expect(failure.metadata?.user).toBe(primary.runtime);
      expect(failure.message).toContain(primary.database);
      expect(failure.message).not.toContain(password);
      expect(JSON.stringify(failure.toJSON())).not.toContain(password);
      expect(JSON.stringify(failure.metadata)).not.toContain('password');
    },
    DB_TIMEOUT,
  );

  it(
    'scrubs a credential the server itself echoes back',
    async () => {
      // Postgres answers a bad login with `password authentication failed for
      // user "…"`. A role whose password is that very word therefore has its
      // credential in the driver's own message, which is the case the scrubbing
      // exists for — and the case a `throw error` implementation leaks.
      const error = await openDataPlaneConnection({
        target: { ...runtimeTarget(primary), password: 'password' },
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(DataPlaneConnectionError);
      const failure = error as DataPlaneConnectionError;
      expect(failure.metadata?.sqlState).toBe('28P01');
      // The server's text survived, with the credential replaced in place.
      expect(failure.message).toContain('[redacted] authentication failed for user');
      expect(failure.message).not.toContain('password');
    },
    DB_TIMEOUT,
  );

  it(
    'refuses an unreachable placement and keeps the connection string out of the error',
    async () => {
      const password = `secret-${randomBytes(8).toString('hex')}`;
      const connectionString = `postgres://${primary.runtime}:${password}@127.0.0.1:1/${primary.database}`;
      const error = await openDataPlaneConnection({
        target: { connectionString },
        connectTimeoutSeconds: 2,
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(DataPlaneConnectionError);
      const failure = error as DataPlaneConnectionError;
      expect(failure.message).not.toContain(password);
      expect(failure.message).not.toContain(connectionString);
      expect(JSON.stringify(failure.toJSON())).not.toContain(password);
      // The non-secret coordinates survive, so the failure is still diagnosable.
      expect(failure.metadata?.database).toBe(primary.database);
      expect(failure.metadata?.host).toBe('127.0.0.1');
    },
    DB_TIMEOUT,
  );

  it(
    'leaves no backend behind when a connection is refused',
    async () => {
      const before = await backendCount(primary.database, primary.runtime);
      await openDataPlaneConnection({
        target: { ...runtimeTarget(primary), password: 'not-the-password' },
      }).catch(() => undefined);
      expect(await waitForBackendCount(primary.database, primary.runtime, before)).toBe(before);
    },
    DB_TIMEOUT,
  );
});

describe('openDataPlaneConnection as the pooled resolver connect step', () => {
  it(
    'routes two tenants to two databases and closes both with the resolver',
    async () => {
      const placements = new Map(fixtures.map((fixture) => [fixture.tenantRef, fixture]));
      const resolver = createPooledDataPlaneResolver<DataPlaneFixture>({
        describe: async (tenantRef) => {
          const placement = placements.get(tenantRef);
          return placement ? { connectionInfo: placement } : undefined;
        },
        connect: ({ descriptor }) =>
          openDataPlaneConnection({
            target: {
              host: admin.host,
              port: admin.port,
              database: descriptor.connectionInfo.database,
              user: descriptor.connectionInfo.runtime,
              password: descriptor.connectionInfo.runtimePassword,
            },
            maxConnections: 2,
          }),
      });

      const first = await resolver.resolve(primary.tenantRef);
      const second = await resolver.resolve(secondary.tenantRef);

      expect(await currentDatabase(first.db)).toBe(primary.database);
      expect(await currentDatabase(second.db)).toBe(secondary.database);

      await resolver.close();

      expect(await waitForBackendCount(primary.database, primary.runtime, 0)).toBe(0);
      expect(await waitForBackendCount(secondary.database, secondary.runtime, 0)).toBe(0);
    },
    DB_TIMEOUT,
  );
});
