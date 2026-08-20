import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeIdentifier,
  DataPlaneGuardError,
  DataPlaneNameError,
  DataPlaneProvisioningError,
  dropDataPlane,
  provisionDataPlane,
  quoteIdentifier,
} from '../data-plane-provisioning.js';

// These tests provision real databases and roles. They require a reachable
// Postgres with cluster-level rights and must FAIL — never silently pass — when
// one is not available: a green run has to mean the DDL actually executed.
const admin = {
  host: process.env.PLUMBUS_TEST_PG_HOST ?? 'localhost',
  port: Number(process.env.PLUMBUS_TEST_PG_PORT ?? '5442'),
  database: process.env.PLUMBUS_TEST_PG_DATABASE ?? 'postgres',
  user: process.env.PLUMBUS_TEST_PG_USER ?? 'postgres',
  password: process.env.PLUMBUS_TEST_PG_PASSWORD ?? 'postgres',
};

/** The naming convention every fixture in this file obeys, and the drop guard. */
const FIXTURE_PATTERN = /^plumbus_test_[a-z0-9_]+$/;

const DB_TIMEOUT = 30_000;

interface FixtureNames {
  database: string;
  owner: string;
  runtime: string;
  ownerPassword: string;
  runtimePassword: string;
  /** Additional roles a test created out of band, dropped with the fixture. */
  extraRoles: string[];
}

const provisioned: FixtureNames[] = [];

function newFixture(): FixtureNames {
  const suffix = randomBytes(5).toString('hex');
  const fixture: FixtureNames = {
    database: `plumbus_test_${suffix}`,
    owner: `plumbus_test_${suffix}_owner`,
    runtime: `plumbus_test_${suffix}_runtime`,
    ownerPassword: `owner-${suffix}`,
    runtimePassword: `runtime-${suffix}`,
    extraRoles: [],
  };
  provisioned.push(fixture);
  return fixture;
}

function connect(options: { database: string; user: string; password: string }): postgres.Sql {
  return postgres({
    host: admin.host,
    port: admin.port,
    database: options.database,
    username: options.user,
    password: options.password,
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

async function withClient<T>(
  options: { database: string; user: string; password: string },
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const client = connect(options);
  try {
    return await fn(client);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function withAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>, database?: string): Promise<T> {
  return withClient(
    { database: database ?? admin.database, user: admin.user, password: admin.password },
    fn,
  );
}

/** Runs a statement expected to be rejected and returns its SQLSTATE. */
async function sqlStateOfFailure(client: postgres.Sql, statement: string): Promise<string> {
  try {
    await client.unsafe(statement);
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-sqlstate';
  }
  throw new Error(`Expected "${statement}" to be rejected, but it succeeded`);
}

async function provisionFixture(fixture: FixtureNames, schemas?: string[]) {
  return provisionDataPlane({
    adminConnection: admin,
    databaseName: fixture.database,
    ownerRole: { name: fixture.owner, password: fixture.ownerPassword },
    runtimeRole: { name: fixture.runtime, password: fixture.runtimePassword },
    namePattern: FIXTURE_PATTERN,
    ...(schemas ? { schemas } : {}),
  });
}

let adminProbe: Promise<void> | undefined;

/**
 * Asserts a usable admin connection. Wired as `beforeEach` in the database-backed
 * suites so an unreachable or under-privileged Postgres fails each of those tests
 * individually — there is no path on which they skip and the run stays green.
 */
function requireProvisioningAdmin(): Promise<void> {
  adminProbe ??= withAdmin(async (sql) => {
    const rows = await sql<{ superuser: boolean; createdb: boolean; createrole: boolean }[]>`
      SELECT rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole
      FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER
    `;
    const row = rows[0];
    if (!row) throw new Error('Could not read the admin role attributes');
    if (!row.superuser && !(row.createdb && row.createrole)) {
      throw new Error(
        'The configured admin role needs CREATEDB and CREATEROLE (or superuser) to run these tests',
      );
    }
  });
  return adminProbe;
}

afterAll(async () => {
  for (const fixture of provisioned) {
    await dropDataPlane({
      adminConnection: admin,
      databaseName: fixture.database,
      roles: [fixture.owner, fixture.runtime, ...fixture.extraRoles],
      allowedNamePattern: FIXTURE_PATTERN,
    }).catch(() => undefined);
  }
}, DB_TIMEOUT);

describe('identifier safety', () => {
  it('rejects identifiers that could terminate a quoted identifier', () => {
    for (const hostile of [
      'x"; DROP DATABASE other; --',
      'tenant"a',
      "tenant';",
      'tenant a',
      'tenant-a',
      'Tenant',
      '1tenant',
      'tenant$a',
      'tenant\\a',
      '',
      'a'.repeat(64),
    ]) {
      expect(() => assertSafeIdentifier(hostile, 'databaseName')).toThrow(DataPlaneNameError);
    }
  });

  it('rejects the reserved pg_ prefix and non-string input', () => {
    expect(() => assertSafeIdentifier('pg_tenant', 'databaseName')).toThrow(DataPlaneNameError);
    expect(() => assertSafeIdentifier(undefined, 'databaseName')).toThrow(DataPlaneNameError);
    expect(() => assertSafeIdentifier(42, 'databaseName')).toThrow(DataPlaneNameError);
  });

  it('accepts conventional names and enforces a caller pattern on top', () => {
    expect(assertSafeIdentifier('tenant_a', 'databaseName')).toBe('tenant_a');
    expect(assertSafeIdentifier('plumbus_test_a1', 'databaseName', FIXTURE_PATTERN)).toBe(
      'plumbus_test_a1',
    );
    expect(() => assertSafeIdentifier('tenant_a', 'databaseName', FIXTURE_PATTERN)).toThrow(
      DataPlaneNameError,
    );
  });

  it('quotes identifiers rather than interpolating them', () => {
    expect(quoteIdentifier('tenant_a')).toBe('"tenant_a"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });

  it('refuses hostile names before opening any connection', async () => {
    await expect(
      provisionDataPlane({
        adminConnection: {
          host: 'unreachable.invalid',
          port: 1,
          database: 'x',
          user: 'x',
          password: 'x',
        },
        databaseName: 'x"; DROP DATABASE other; --',
        ownerRole: 'owner_role',
        runtimeRole: 'runtime_role',
      }),
    ).rejects.toBeInstanceOf(DataPlaneNameError);
  });

  it('refuses an owner and runtime role that are the same principal', async () => {
    await expect(
      provisionDataPlane({
        adminConnection: admin,
        databaseName: 'plumbus_test_never_created',
        ownerRole: 'plumbus_test_same_role',
        runtimeRole: 'plumbus_test_same_role',
      }),
    ).rejects.toBeInstanceOf(DataPlaneNameError);
  });

  it('still validates schema names as identifiers even though the convention exempts them', async () => {
    await expect(
      provisionDataPlane({
        adminConnection: admin,
        databaseName: 'plumbus_test_never_created',
        ownerRole: 'plumbus_test_o',
        runtimeRole: 'plumbus_test_r',
        namePattern: FIXTURE_PATTERN,
        schemas: ['core_plumbus"; DROP SCHEMA public CASCADE; --'],
      }),
    ).rejects.toBeInstanceOf(DataPlaneNameError);
  });

  it('rejects a table privilege outside the allowlist', async () => {
    await expect(
      provisionDataPlane({
        adminConnection: admin,
        databaseName: 'plumbus_test_never_created',
        ownerRole: 'plumbus_test_o',
        runtimeRole: 'plumbus_test_r',
        runtimeTablePrivileges: ['SELECT; DROP TABLE x'],
      }),
    ).rejects.toBeInstanceOf(DataPlaneNameError);
  });
});

describe('provisionDataPlane', () => {
  beforeEach(requireProvisioningAdmin, DB_TIMEOUT);

  it(
    'creates the database, both roles and their grants',
    async () => {
      const fixture = newFixture();
      const result = await provisionFixture(fixture);

      expect(result.databaseCreated).toBe(true);
      expect(result.rolesCreated).toEqual([fixture.owner, fixture.runtime]);
      expect(result.rolesAlreadyPresent).toEqual([]);
      expect(
        result.steps.some((s) => s.step === 'create-database' && s.outcome === 'created'),
      ).toBe(true);
      expect(
        result.steps.some(
          (s) => s.step === 'revoke-database-from-public' && s.outcome === 'applied',
        ),
      ).toBe(true);
      // The recorded statements must never carry a password literal.
      for (const step of result.steps) {
        expect(step.statement).not.toContain(fixture.ownerPassword);
        expect(step.statement).not.toContain(fixture.runtimePassword);
      }

      await withAdmin(async (sql) => {
        const [db] = await sql<{ owner: string }[]>`
          SELECT pg_catalog.pg_get_userbyid(datdba) AS owner
          FROM pg_catalog.pg_database WHERE datname = ${fixture.database}
        `;
        expect(db?.owner).toBe(fixture.owner);

        const [runtimeRole] = await sql<
          {
            login: boolean;
            superuser: boolean;
            createdb: boolean;
            createrole: boolean;
            replication: boolean;
            bypassrls: boolean;
          }[]
        >`
          SELECT rolcanlogin AS login, rolsuper AS superuser, rolcreatedb AS createdb,
                 rolcreaterole AS createrole, rolreplication AS replication,
                 rolbypassrls AS bypassrls
          FROM pg_catalog.pg_roles WHERE rolname = ${fixture.runtime}
        `;
        expect(runtimeRole).toEqual({
          login: true,
          superuser: false,
          createdb: false,
          createrole: false,
          replication: false,
          bypassrls: false,
        });
      });
    },
    DB_TIMEOUT,
  );

  it(
    'is idempotent: a second run reports already-present and creates nothing',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);
      const second = await provisionFixture(fixture);

      expect(second.databaseCreated).toBe(false);
      expect(second.rolesCreated).toEqual([]);
      expect(second.rolesAlreadyPresent).toEqual([fixture.owner, fixture.runtime]);
      expect(
        second.steps.filter((s) => s.step === 'create-database').map((s) => s.outcome),
      ).toEqual(['already-present']);
    },
    DB_TIMEOUT,
  );

  it(
    'resumes when the database already exists but the roles do not',
    async () => {
      const fixture = newFixture();
      // Simulate a run interrupted after CREATE DATABASE. The owner role is created
      // out of band because CREATE DATABASE ... OWNER requires it to exist.
      await withAdmin(async (sql) => {
        await sql.unsafe(`CREATE ROLE ${quoteIdentifier(fixture.owner)} WITH LOGIN`);
        await sql.unsafe(
          `CREATE DATABASE ${quoteIdentifier(fixture.database)} OWNER ${quoteIdentifier(fixture.owner)}`,
        );
      });

      const result = await provisionFixture(fixture);
      expect(result.databaseCreated).toBe(false);
      expect(result.rolesAlreadyPresent).toEqual([fixture.owner]);
      expect(result.rolesCreated).toEqual([fixture.runtime]);
    },
    DB_TIMEOUT,
  );

  it(
    'gives the runtime role DML but withholds DDL, including on tables created later',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);

      // The owner is the migration identity: it creates the schema objects.
      await withClient(
        { database: fixture.database, user: fixture.owner, password: fixture.ownerPassword },
        async (sql) => {
          await sql.unsafe('CREATE TABLE ledger (id serial PRIMARY KEY, label text NOT NULL)');
        },
      );

      await withClient(
        { database: fixture.database, user: fixture.runtime, password: fixture.runtimePassword },
        async (sql) => {
          // Default privileges cover the table created after provisioning ran.
          await sql.unsafe("INSERT INTO ledger (label) VALUES ('a')");
          const rows = await sql<{ label: string }[]>`SELECT label FROM ledger`;
          expect(rows.map((r) => r.label)).toEqual(['a']);
          await sql.unsafe("UPDATE ledger SET label = 'b'");
          await sql.unsafe('DELETE FROM ledger');

          // 42501 = insufficient_privilege.
          expect(await sqlStateOfFailure(sql, 'CREATE TABLE intruder (id int)')).toBe('42501');
          expect(await sqlStateOfFailure(sql, 'DROP TABLE ledger')).toBe('42501');
        },
      );
    },
    DB_TIMEOUT,
  );

  it(
    'revokes PUBLIC so another tenant runtime role cannot reach the database',
    async () => {
      const tenantA = newFixture();
      const tenantB = newFixture();
      await provisionFixture(tenantA);
      await provisionFixture(tenantB);

      await withAdmin(async (sql) => {
        const [row] = await sql<{ allowed: boolean }[]>`
          SELECT pg_catalog.has_database_privilege(${tenantB.runtime}, ${tenantA.database}, 'CONNECT')
            AS allowed
        `;
        expect(row?.allowed).toBe(false);
      });

      const stranger = connect({
        database: tenantA.database,
        user: tenantB.runtime,
        password: tenantB.runtimePassword,
      });
      try {
        const state = await sqlStateOfFailure(stranger, 'SELECT 1');
        expect(state).toBe('42501');
      } finally {
        await stranger.end({ timeout: 5 }).catch(() => undefined);
      }
    },
    DB_TIMEOUT,
  );

  it(
    'escapes role passwords containing quotes, backslashes and replacement patterns',
    async () => {
      const fixture = newFixture();
      // `$&`, `$'` and a backtick are String.replace substitution patterns: a
      // password carrying them must reach Postgres verbatim, not expanded.
      fixture.ownerPassword = `o'w"n\\er--;$&$'$\`${fixture.ownerPassword}`;
      fixture.runtimePassword = `r'u"n\\time--;$&$'$\`${fixture.runtimePassword}`;
      await provisionFixture(fixture);

      await withClient(
        { database: fixture.database, user: fixture.runtime, password: fixture.runtimePassword },
        async (sql) => {
          const [row] = await sql<{ who: string }[]>`SELECT CURRENT_USER::text AS who`;
          expect(row?.who).toBe(fixture.runtime);
        },
      );
    },
    DB_TIMEOUT,
  );

  it(
    'accepts a connection string admin connection and still targets the new database',
    async () => {
      const fixture = newFixture();
      const connectionString = `postgres://${encodeURIComponent(admin.user)}:${encodeURIComponent(
        admin.password,
      )}@${admin.host}:${admin.port}/${admin.database}`;

      const result = await provisionDataPlane({
        adminConnection: { connectionString },
        databaseName: fixture.database,
        ownerRole: { name: fixture.owner, password: fixture.ownerPassword },
        runtimeRole: { name: fixture.runtime, password: fixture.runtimePassword },
        namePattern: FIXTURE_PATTERN,
        schemas: ['core_plumbus'],
      });
      expect(result.databaseCreated).toBe(true);
      expect(result.schemasCreated).toEqual(['core_plumbus']);

      // The schema must exist in the tenant database and nowhere else: proof the
      // second connection re-targeted the database rather than reusing the URL's.
      await withClient(
        { database: fixture.database, user: fixture.owner, password: fixture.ownerPassword },
        async (sql) => {
          const rows = await sql<{ nspname: string }[]>`
            SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = 'core_plumbus'
          `;
          expect(rows).toHaveLength(1);
        },
      );
      await withAdmin(async (sql) => {
        const rows = await sql<{ nspname: string }[]>`
          SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = 'core_plumbus'
        `;
        expect(rows).toHaveLength(0);
      });
    },
    DB_TIMEOUT,
  );

  it(
    'works when the admin role is not a superuser but holds CREATEDB and CREATEROLE',
    async () => {
      const fixture = newFixture();
      const provisioner = `${fixture.database}_admin`;
      const provisionerPassword = `provisioner${randomBytes(4).toString('hex')}`;
      fixture.extraRoles.push(provisioner);

      await withAdmin(async (sql) => {
        await sql.unsafe(
          `CREATE ROLE ${quoteIdentifier(provisioner)} WITH LOGIN CREATEDB CREATEROLE PASSWORD '${provisionerPassword}'`,
        );
      });

      const result = await provisionDataPlane({
        adminConnection: {
          host: admin.host,
          port: admin.port,
          database: admin.database,
          user: provisioner,
          password: provisionerPassword,
        },
        databaseName: fixture.database,
        ownerRole: { name: fixture.owner, password: fixture.ownerPassword },
        runtimeRole: { name: fixture.runtime, password: fixture.runtimePassword },
        namePattern: FIXTURE_PATTERN,
      });

      expect(result.databaseCreated).toBe(true);
      // The admin had to take membership of the owner role to set the database
      // owner and the default privileges.
      expect(
        result.steps.some((s) => s.step === 'grant-role-membership' && s.outcome === 'applied'),
      ).toBe(true);

      // The privileges the non-superuser admin granted must be real ones.
      await withClient(
        { database: fixture.database, user: fixture.owner, password: fixture.ownerPassword },
        async (sql) => {
          await sql.unsafe('CREATE TABLE ledger (id serial PRIMARY KEY)');
        },
      );
      await withClient(
        { database: fixture.database, user: fixture.runtime, password: fixture.runtimePassword },
        async (sql) => {
          await sql.unsafe('INSERT INTO ledger DEFAULT VALUES');
          expect(await sqlStateOfFailure(sql, 'CREATE TABLE intruder (id int)')).toBe('42501');
        },
      );
    },
    DB_TIMEOUT,
  );

  it(
    'rotates an existing role password only when asked to',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);
      const rotated = `rotated-${randomBytes(4).toString('hex')}`;

      // Default: an existing role is left alone.
      const untouched = await provisionDataPlane({
        adminConnection: admin,
        databaseName: fixture.database,
        ownerRole: { name: fixture.owner, password: fixture.ownerPassword },
        runtimeRole: { name: fixture.runtime, password: rotated },
        namePattern: FIXTURE_PATTERN,
      });
      expect(untouched.steps.some((s) => s.step === 'alter-role-password')).toBe(false);
      await withClient(
        { database: fixture.database, user: fixture.runtime, password: fixture.runtimePassword },
        async (sql) => {
          await sql`SELECT 1`;
        },
      );

      const updated = await provisionDataPlane({
        adminConnection: admin,
        databaseName: fixture.database,
        ownerRole: { name: fixture.owner, password: fixture.ownerPassword },
        runtimeRole: { name: fixture.runtime, password: rotated },
        namePattern: FIXTURE_PATTERN,
        updateExistingRolePasswords: true,
      });
      expect(
        updated.steps.some((s) => s.step === 'alter-role-password' && s.outcome === 'updated'),
      ).toBe(true);
      await withClient(
        { database: fixture.database, user: fixture.runtime, password: rotated },
        async (sql) => {
          const [row] = await sql<{ who: string }[]>`SELECT CURRENT_USER::text AS who`;
          expect(row?.who).toBe(fixture.runtime);
        },
      );
      fixture.runtimePassword = rotated;
    },
    DB_TIMEOUT,
  );

  it(
    'reports the failing step when the admin connection lacks provisioning rights',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);

      const error = await provisionDataPlane({
        // The runtime role has LOGIN but neither CREATEROLE nor CREATEDB.
        adminConnection: {
          host: admin.host,
          port: admin.port,
          database: admin.database,
          user: fixture.runtime,
          password: fixture.runtimePassword,
        },
        databaseName: `${fixture.database}_second`,
        ownerRole: `${fixture.owner}_second`,
        runtimeRole: `${fixture.runtime}_second`,
        namePattern: FIXTURE_PATTERN,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DataPlaneProvisioningError);
      expect((error as DataPlaneProvisioningError).metadata).toMatchObject({
        step: 'create-role',
        sqlState: '42501',
      });
    },
    DB_TIMEOUT,
  );

  it(
    'creates additional schemas owned by the owner role with the same runtime grants',
    async () => {
      const fixture = newFixture();
      const result = await provisionFixture(fixture, ['core_plumbus']);
      expect(result.schemasCreated).toEqual(['core_plumbus']);
      expect((await provisionFixture(fixture, ['core_plumbus'])).schemasAlreadyPresent).toEqual([
        'core_plumbus',
      ]);

      await withClient(
        { database: fixture.database, user: fixture.owner, password: fixture.ownerPassword },
        async (sql) => {
          await sql.unsafe('CREATE TABLE core_plumbus.entries (id serial PRIMARY KEY)');
        },
      );

      await withClient(
        { database: fixture.database, user: fixture.runtime, password: fixture.runtimePassword },
        async (sql) => {
          await sql.unsafe('INSERT INTO core_plumbus.entries DEFAULT VALUES');
          const rows = await sql<{ id: number }[]>`SELECT id FROM core_plumbus.entries`;
          expect(rows).toHaveLength(1);
          expect(await sqlStateOfFailure(sql, 'CREATE TABLE core_plumbus.intruder (id int)')).toBe(
            '42501',
          );
        },
      );
    },
    DB_TIMEOUT,
  );
});

describe('dropDataPlane', () => {
  beforeEach(requireProvisioningAdmin, DB_TIMEOUT);

  it(
    'refuses a database or role outside the caller-supplied naming convention',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);

      await expect(
        dropDataPlane({
          adminConnection: admin,
          databaseName: fixture.database,
          allowedNamePattern: /^plumbus_fixture_[a-z0-9_]+$/,
        }),
      ).rejects.toBeInstanceOf(DataPlaneGuardError);

      await expect(
        dropDataPlane({
          adminConnection: admin,
          databaseName: fixture.database,
          roles: ['postgres'],
          allowedNamePattern: FIXTURE_PATTERN,
        }),
      ).rejects.toBeInstanceOf(DataPlaneGuardError);

      // The refusals must not have dropped anything.
      await withAdmin(async (sql) => {
        const rows = await sql<{ one: number }[]>`
          SELECT 1 AS one FROM pg_catalog.pg_database WHERE datname = ${fixture.database}
        `;
        expect(rows).toHaveLength(1);
      });
    },
    DB_TIMEOUT,
  );

  it(
    'refuses to drop the database the admin connection is itself using',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);

      await expect(
        dropDataPlane({
          adminConnection: { ...admin, database: fixture.database },
          databaseName: fixture.database,
          allowedNamePattern: FIXTURE_PATTERN,
        }),
      ).rejects.toBeInstanceOf(DataPlaneGuardError);

      await withAdmin(async (sql) => {
        const rows = await sql<{ one: number }[]>`
          SELECT 1 AS one FROM pg_catalog.pg_database WHERE datname = ${fixture.database}
        `;
        expect(rows).toHaveLength(1);
      });
    },
    DB_TIMEOUT,
  );

  it(
    'drops the database and roles, and is idempotent on a second call',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);

      const first = await dropDataPlane({
        adminConnection: admin,
        databaseName: fixture.database,
        roles: [fixture.owner, fixture.runtime],
        allowedNamePattern: FIXTURE_PATTERN,
      });
      expect(first.databaseDropped).toBe(true);
      expect(first.rolesDropped).toEqual([fixture.owner, fixture.runtime]);

      const second = await dropDataPlane({
        adminConnection: admin,
        databaseName: fixture.database,
        roles: [fixture.owner, fixture.runtime],
        allowedNamePattern: FIXTURE_PATTERN,
      });
      expect(second.databaseDropped).toBe(false);
      expect(second.rolesDropped).toEqual([]);
      expect(second.rolesAbsent).toEqual([fixture.owner, fixture.runtime]);

      await withAdmin(async (sql) => {
        const dbs = await sql<{ one: number }[]>`
          SELECT 1 AS one FROM pg_catalog.pg_database WHERE datname = ${fixture.database}
        `;
        const roles = await sql<{ rolname: string }[]>`
          SELECT rolname FROM pg_catalog.pg_roles
          WHERE rolname IN (${fixture.owner}, ${fixture.runtime})
        `;
        expect(dbs).toHaveLength(0);
        expect(roles).toHaveLength(0);
      });
    },
    DB_TIMEOUT,
  );

  it(
    'terminates live sessions before dropping the database',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);

      const lingering = connect({
        database: fixture.database,
        user: fixture.runtime,
        password: fixture.runtimePassword,
      });
      await lingering`SELECT 1`;

      try {
        const result = await dropDataPlane({
          adminConnection: admin,
          databaseName: fixture.database,
          roles: [fixture.owner, fixture.runtime],
          allowedNamePattern: FIXTURE_PATTERN,
        });
        expect(result.terminatedConnections).toBeGreaterThan(0);
        expect(result.databaseDropped).toBe(true);
      } finally {
        await lingering.end({ timeout: 5 }).catch(() => undefined);
      }
    },
    DB_TIMEOUT,
  );

  it(
    'evaluates a global-flagged guard pattern statelessly',
    async () => {
      const fixture = newFixture();
      await provisionFixture(fixture);
      // A /g regex keeps `lastIndex` across .test() calls; the guard must not
      // therefore accept a name once and refuse the identical name next time.
      const globalPattern = /^plumbus_test_[a-z0-9_]+$/g;

      const first = await dropDataPlane({
        adminConnection: admin,
        databaseName: fixture.database,
        allowedNamePattern: globalPattern,
      });
      expect(first.databaseDropped).toBe(true);

      const second = await dropDataPlane({
        adminConnection: admin,
        databaseName: fixture.database,
        roles: [fixture.owner, fixture.runtime],
        allowedNamePattern: globalPattern,
      });
      expect(second.databaseDropped).toBe(false);
      expect(second.rolesDropped).toEqual([fixture.owner, fixture.runtime]);
    },
    DB_TIMEOUT,
  );
});
