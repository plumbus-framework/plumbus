// ── Per-request data-plane routing, end to end ──
//
// Two real tenant databases plus a real control-plane database, provisioned by
// the framework's own `provisionDataPlane`, resolved through a pooled resolver
// and driven through the actual HTTP surface `createServer` builds. What is
// being proven is isolation: a capability serving tenant A cannot read the row
// tenant B wrote, because the two ran against different databases.
//
// These tests require a reachable Postgres with cluster-level rights and must
// FAIL — never silently pass — when one is not available. A green run has to
// mean two databases really were created, written to, and read back.

import { randomBytes } from 'node:crypto';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthAdapter } from '../../auth/adapter.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import { dropDataPlane, provisionDataPlane } from '../../tenancy/data-plane-provisioning.js';
import { createPooledDataPlaneResolver } from '../../tenancy/data-plane-resolver.js';
import type { PooledDataPlaneResolver } from '../../tenancy/types.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { EntityDefinition } from '../../types/entity.js';
import type { AuthContext } from '../../types/security.js';
import type { PlumbusServer, ServerConfig } from '../bootstrap.js';
import { createServer } from '../bootstrap.js';

const admin = {
  host: process.env.PLUMBUS_TEST_PG_HOST ?? 'localhost',
  port: Number(process.env.PLUMBUS_TEST_PG_PORT ?? '5442'),
  database: process.env.PLUMBUS_TEST_PG_DATABASE ?? 'postgres',
  user: process.env.PLUMBUS_TEST_PG_USER ?? 'postgres',
  password: process.env.PLUMBUS_TEST_PG_PASSWORD ?? 'postgres',
};

/** The naming convention every fixture in this file obeys, and the drop guard. */
const FIXTURE_PATTERN = /^plumbus_test_dpr_[a-z0-9_]+$/;

const DB_TIMEOUT = 60_000;

// ── Fixture data planes ──

interface DataPlaneFixture {
  /** Tenant reference the resolver is keyed by. */
  tenantRef: string;
  database: string;
  owner: string;
  runtime: string;
  ownerPassword: string;
  runtimePassword: string;
}

const fixtures: DataPlaneFixture[] = [];

function newFixture(label: string): DataPlaneFixture {
  const suffix = `${label}_${randomBytes(4).toString('hex')}`;
  const fixture: DataPlaneFixture = {
    tenantRef: `tenant-${suffix}`,
    database: `plumbus_test_dpr_${suffix}`,
    owner: `plumbus_test_dpr_${suffix}_owner`,
    runtime: `plumbus_test_dpr_${suffix}_runtime`,
    ownerPassword: `owner-${suffix}`,
    runtimePassword: `runtime-${suffix}`,
  };
  fixtures.push(fixture);
  return fixture;
}

const tenantA = newFixture('a');
const tenantB = newFixture('b');
const controlPlane = newFixture('cp');

/** Everything the test opens, closed before the databases are dropped. */
const openClients: postgres.Sql[] = [];

function connect(options: { database: string; user: string; password: string }): postgres.Sql {
  const client = postgres({
    host: admin.host,
    port: admin.port,
    database: options.database,
    username: options.user,
    password: options.password,
    max: 2,
    connect_timeout: 10,
    onnotice: () => {},
  });
  openClients.push(client);
  return client;
}

/**
 * The tables a capability touches in a tenant's data plane: the entity's own
 * table and the audit trail every mutation writes. Created as the owner role so
 * the runtime role picks them up through the default privileges provisioning
 * installed.
 */
const LEDGER_ENTRY_DDL = `
  CREATE TABLE ledger_entry (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label text,
    tenant_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

/**
 * A second table behind an entity that is not tenant-scoped. Untenanted work is
 * only observable through one of these — a tenant-scoped entity refuses a
 * caller with no tenant before any database is involved, which would hide
 * whichever data plane the request actually reached.
 */
const PLATFORM_NOTE_DDL = `
  CREATE TABLE platform_note (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

const AUDIT_RECORDS_DDL = `
  CREATE TABLE audit_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor text NOT NULL,
    tenant_id text,
    timestamp timestamptz NOT NULL DEFAULT now(),
    component text NOT NULL,
    action text NOT NULL,
    outcome text NOT NULL,
    metadata jsonb,
    masked_fields jsonb
  )
`;

async function provisionFixture(fixture: DataPlaneFixture): Promise<void> {
  await provisionDataPlane({
    adminConnection: admin,
    databaseName: fixture.database,
    ownerRole: { name: fixture.owner, password: fixture.ownerPassword },
    runtimeRole: { name: fixture.runtime, password: fixture.runtimePassword },
    namePattern: FIXTURE_PATTERN,
  });

  const owner = connect({
    database: fixture.database,
    user: fixture.owner,
    password: fixture.ownerPassword,
  });
  await owner.unsafe(LEDGER_ENTRY_DDL);
  await owner.unsafe(PLATFORM_NOTE_DDL);
  await owner.unsafe(AUDIT_RECORDS_DDL);
}

/** Rows a data plane holds, read straight from Postgres rather than through the framework. */
async function readLabels(fixture: DataPlaneFixture): Promise<string[]> {
  const client = connect({
    database: fixture.database,
    user: fixture.owner,
    password: fixture.ownerPassword,
  });
  const rows = await client<{ label: string }[]>`SELECT label FROM ledger_entry ORDER BY label`;
  return rows.map((row) => row.label);
}

async function readNotes(fixture: DataPlaneFixture): Promise<string[]> {
  const client = connect({
    database: fixture.database,
    user: fixture.owner,
    password: fixture.ownerPassword,
  });
  const rows = await client<{ label: string }[]>`SELECT label FROM platform_note ORDER BY label`;
  return rows.map((row) => row.label);
}

// ── Framework wiring ──

const ledgerEntry: EntityDefinition = {
  name: 'ledgerEntry',
  tenantScoped: true,
  fields: {
    id: { type: 'id', options: {} },
    label: { type: 'string', options: {} },
  },
};

const platformNote: EntityDefinition = {
  name: 'platformNote',
  fields: {
    id: { type: 'id', options: {} },
    label: { type: 'string', options: {} },
  },
};

const recordEntry: CapabilityContract = {
  name: 'recordEntry',
  kind: 'action',
  domain: 'ledger',
  input: z.object({ label: z.string() }),
  output: z.object({ label: z.string() }),
  effects: { data: ['ledgerEntry'], events: [], external: [], ai: false },
  access: { roles: ['member'] },
  handler: async (ctx, input) => {
    const created = await ctx.data.ledgerEntry.create({ label: input.label });
    return { label: created.label as string };
  },
} as unknown as CapabilityContract;

const listEntries: CapabilityContract = {
  name: 'listEntries',
  kind: 'query',
  domain: 'ledger',
  input: z.object({}),
  output: z.object({ labels: z.array(z.string()) }),
  effects: { data: ['ledgerEntry'], events: [], external: [], ai: false },
  access: { roles: ['member'] },
  handler: async (ctx) => {
    const rows = (await ctx.data.ledgerEntry.findMany()) as { label: string }[];
    return { labels: rows.map((row) => row.label).sort() };
  },
} as unknown as CapabilityContract;

const recordNote: CapabilityContract = {
  name: 'recordNote',
  kind: 'action',
  domain: 'platform',
  input: z.object({ label: z.string() }),
  output: z.object({ label: z.string() }),
  effects: { data: ['platformNote'], events: [], external: [], ai: false },
  access: { roles: ['member'] },
  handler: async (ctx, input) => {
    const created = await ctx.data.platformNote.create({ label: input.label });
    return { label: created.label as string };
  },
} as unknown as CapabilityContract;

/**
 * Bearer token carries the tenant reference verbatim, so a test says which
 * tenant it is by which token it sends. `untenanted` authenticates a caller
 * with the right role but no tenant at all — the case the policy governs.
 */
const tenantAuthAdapter: AuthAdapter = {
  authenticate: async (authHeader?: string) => {
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const auth: AuthContext = {
      userId: `user-of-${token}`,
      roles: ['member'],
      scopes: [],
      provider: 'test',
      ...(token === 'untenanted' ? {} : { tenantId: token }),
    };
    return auth;
  },
};

function makeConfig(): PlumbusConfig {
  return {
    environment: 'production',
    database: {
      host: admin.host,
      port: admin.port,
      database: admin.database,
      user: admin.user,
      password: admin.password,
      ssl: false,
      poolSize: 2,
    },
    queue: { host: 'localhost', port: 6379, prefix: 'plumbus:data-plane-routing' },
    auth: { provider: 'jwt' },
  } as PlumbusConfig;
}

function makeServerConfig(overrides: Partial<ServerConfig>): ServerConfig {
  const capabilities = new CapabilityRegistry();
  capabilities.register(recordEntry);
  capabilities.register(listEntries);
  capabilities.register(recordNote);
  const entities = new EntityRegistry();
  entities.register(ledgerEntry);
  entities.register(platformNote);
  return {
    config: makeConfig(),
    db: controlPlaneDb,
    capabilities,
    entities,
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    authAdapter: tenantAuthAdapter,
    ...overrides,
  };
}

interface CapabilityResponse {
  statusCode: number;
  body: { data?: { labels?: string[]; label?: string }; error?: { code: string; message: string } };
}

async function callCapability(
  server: PlumbusServer,
  options: { method: 'GET' | 'POST'; path: string; token?: string; payload?: unknown },
): Promise<CapabilityResponse> {
  const response = await server.app.inject({
    method: options.method,
    url: options.path,
    ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
  return { statusCode: response.statusCode, body: response.json() };
}

async function record(
  server: PlumbusServer,
  token: string,
  label: string,
): Promise<CapabilityResponse> {
  return callCapability(server, {
    method: 'POST',
    path: '/api/ledger/record-entry',
    token,
    payload: { label },
  });
}

async function list(server: PlumbusServer, token: string): Promise<CapabilityResponse> {
  return callCapability(server, { method: 'GET', path: '/api/ledger/list-entries', token });
}

async function note(
  server: PlumbusServer,
  token: string,
  label: string,
): Promise<CapabilityResponse> {
  return callCapability(server, {
    method: 'POST',
    path: '/api/platform/record-note',
    token,
    payload: { label },
  });
}

// ── Fixture lifecycle ──

let controlPlaneDb: PostgresJsDatabase;
let resolver: PooledDataPlaneResolver;
const servers: PlumbusServer[] = [];
/** Kept rather than thrown, so every test reports the setup failure itself. */
let setupError: unknown;

async function setUpDataPlanes(): Promise<void> {
  const probe = connect({
    database: admin.database,
    user: admin.user,
    password: admin.password,
  });
  const roles = await probe<{ superuser: boolean; createdb: boolean; createrole: boolean }[]>`
    SELECT rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole
    FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER
  `;
  const role = roles[0];
  if (!role) throw new Error('Could not read the admin role attributes');
  if (!role.superuser && !(role.createdb && role.createrole)) {
    throw new Error(
      'The configured admin role needs CREATEDB and CREATEROLE (or superuser) to run these tests',
    );
  }

  for (const fixture of fixtures) {
    await provisionFixture(fixture);
  }

  controlPlaneDb = drizzle(
    connect({
      database: controlPlane.database,
      user: controlPlane.runtime,
      password: controlPlane.runtimePassword,
    }),
  );

  const placements = new Map(fixtures.map((fixture) => [fixture.tenantRef, fixture]));
  resolver = createPooledDataPlaneResolver<DataPlaneFixture>({
    describe: async (tenantRef) => {
      const placement = placements.get(tenantRef);
      return placement ? { connectionInfo: placement } : undefined;
    },
    connect: async ({ descriptor }) => {
      const client = connect({
        database: descriptor.connectionInfo.database,
        user: descriptor.connectionInfo.runtime,
        password: descriptor.connectionInfo.runtimePassword,
      });
      return {
        db: drizzle(client),
        close: async () => {
          await client.end({ timeout: 5 });
        },
      };
    },
  });
}

beforeAll(async () => {
  await setUpDataPlanes().catch((error: unknown) => {
    setupError = error;
  });
}, DB_TIMEOUT);

/**
 * An unreachable or under-privileged Postgres fails every test in this file.
 * There is no path on which they skip and the run stays green.
 */
beforeEach(() => {
  if (setupError) throw setupError;
});

afterAll(async () => {
  for (const server of servers) {
    await server.stop().catch(() => undefined);
  }
  await resolver?.close().catch(() => undefined);
  for (const client of openClients) {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
  for (const fixture of fixtures) {
    await dropDataPlane({
      adminConnection: admin,
      databaseName: fixture.database,
      roles: [fixture.owner, fixture.runtime],
      allowedNamePattern: FIXTURE_PATTERN,
    }).catch(() => undefined);
  }
}, DB_TIMEOUT);

function startServer(overrides: Partial<ServerConfig>): PlumbusServer {
  const server = createServer(makeServerConfig(overrides));
  servers.push(server);
  return server;
}

// ── Tests ──

describe('per-request data-plane routing over two real databases', () => {
  it(
    'writes each tenant to its own database and refuses to read across them',
    async () => {
      const server = startServer({ dataPlaneResolver: resolver });

      const writtenA = await record(server, tenantA.tenantRef, 'entry-from-a');
      const writtenB = await record(server, tenantB.tenantRef, 'entry-from-b');
      expect(writtenA.statusCode).toBe(200);
      expect(writtenB.statusCode).toBe(200);

      // Read back through the framework: each tenant sees only its own row.
      const readA = await list(server, tenantA.tenantRef);
      const readB = await list(server, tenantB.tenantRef);
      expect(readA.statusCode).toBe(200);
      expect(readB.statusCode).toBe(200);
      expect(readA.body.data?.labels).toEqual(['entry-from-a']);
      expect(readB.body.data?.labels).toEqual(['entry-from-b']);

      // And in the databases themselves: the rows are physically separated,
      // so no filter, scope or predicate is what stands between them.
      expect(await readLabels(tenantA)).toEqual(['entry-from-a']);
      expect(await readLabels(tenantB)).toEqual(['entry-from-b']);
      expect(await readLabels(controlPlane)).toEqual([]);
    },
    DB_TIMEOUT,
  );

  it(
    'refuses an untenanted request by default and never falls back to another database',
    async () => {
      const server = startServer({ dataPlaneResolver: resolver });

      // `recordNote` would succeed for any resolvable data plane, so a refusal
      // here can only have come from the untenanted-request policy.
      const refused = await note(server, 'untenanted', 'note-from-nobody');
      expect(refused.statusCode).toBe(403);
      expect(refused.body.error?.message).toContain('no tenant reference');

      expect(await readNotes(tenantA)).not.toContain('note-from-nobody');
      expect(await readNotes(tenantB)).not.toContain('note-from-nobody');
      expect(await readNotes(controlPlane)).not.toContain('note-from-nobody');
    },
    DB_TIMEOUT,
  );

  it(
    'refuses a tenant the resolver does not recognise',
    async () => {
      const server = startServer({ dataPlaneResolver: resolver });

      const refused = await note(server, 'tenant-that-was-never-placed', 'note-from-stranger');
      expect(refused.statusCode).toBe(404);
      expect(refused.body.error?.code).toBe('notFound');

      expect(await readNotes(tenantA)).not.toContain('note-from-stranger');
      expect(await readNotes(tenantB)).not.toContain('note-from-stranger');
      expect(await readNotes(controlPlane)).not.toContain('note-from-stranger');
    },
    DB_TIMEOUT,
  );

  it(
    'routes untenanted requests to the control plane when configured to',
    async () => {
      const server = startServer({
        dataPlaneResolver: resolver,
        untenantedDataPlane: 'control-plane',
      });

      const written = await note(server, 'untenanted', 'note-from-control-plane');
      expect(written.statusCode).toBe(200);

      expect(await readNotes(controlPlane)).toContain('note-from-control-plane');
      expect(await readNotes(tenantA)).not.toContain('note-from-control-plane');
      expect(await readNotes(tenantB)).not.toContain('note-from-control-plane');
    },
    DB_TIMEOUT,
  );

  it(
    'keeps the single-database path when no resolver is supplied',
    async () => {
      const server = startServer({
        db: drizzle(
          connect({
            database: tenantA.database,
            user: tenantA.runtime,
            password: tenantA.runtimePassword,
          }),
        ),
      });

      const written = await record(server, tenantA.tenantRef, 'entry-without-resolver');
      expect(written.statusCode).toBe(200);
      expect(await readLabels(tenantA)).toContain('entry-without-resolver');
      expect(await readLabels(tenantB)).not.toContain('entry-without-resolver');
    },
    DB_TIMEOUT,
  );
});
