// The database idempotency store driven through the real HTTP surface `createServer` builds,
// against real Postgres: replay, payload conflicts, live claims, lapsed claims, and the
// completion committing inside the capability's business transaction.

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthAdapter } from '../../auth/adapter.js';
import { EntityRegistry } from '../../data/registry.js';
import { createDurableTestDatabase, resolveTestPostgresAdmin } from '../../durable/index.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import { createServer, type PlumbusServer } from '../../server/bootstrap.js';
import { createSingleDataPlaneResolver } from '../../tenancy/index.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { AuthContext } from '../../types/security.js';
import {
  createDatabaseIdempotencyStore,
  requestIdempotencyDdl,
  sweepExpiredIdempotencyRecords,
} from '../database-idempotency-store.js';
import { buildIdempotencyStoreKey, hashPayload } from '../idempotency.js';

const admin = resolveTestPostgresAdmin();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0)
    await cleanups
      .pop()?.()
      .catch(() => undefined);
});

/** A test database with a pool large enough for concurrent requests. */
async function database(kind: string, ddl: string): Promise<PostgresJsDatabase> {
  const created = await createDurableTestDatabase({ admin, kind, ddl });
  cleanups.push(created.close);
  const client = postgres({
    host: admin.host,
    port: admin.port,
    database: created.name,
    username: admin.user,
    password: admin.password,
    max: 6,
    onnotice: () => {},
  });
  cleanups.push(() => client.end({ timeout: 5 }));
  return drizzle(client);
}

const BUSINESS_DDL = 'CREATE TABLE orders (id text PRIMARY KEY, order_ref text NOT NULL);';

function config(): PlumbusConfig {
  return {
    environment: 'test',
    database: { host: 'x', port: 1, database: 'x', user: 'x', password: 'x' },
    queue: { host: 'x', port: 1 },
    auth: {},
    execution: { transactionalOutbox: true },
  } as unknown as PlumbusConfig;
}

/** Authenticates `Bearer <user>[@<tenant>]`. */
const authAdapter: AuthAdapter = {
  async authenticate(header) {
    const token = header?.replace(/^Bearer /, '');
    if (!token) return null;
    const [userId, tenantId] = token.split('@');
    return {
      userId,
      ...(tenantId ? { tenantId } : {}),
      roles: ['admin'],
      scopes: [],
      provider: 'test',
    } as AuthContext;
  },
};

interface Gate {
  wait: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

interface Probe {
  runs: string[];
  /** Requests whose order ref is listed here wait inside their transaction for the gate. */
  holds: Map<string, Gate>;
  entered: Map<string, () => void>;
}

function placeOrder(probe: Probe, transactional = true): CapabilityContract {
  return {
    name: 'placeOrder',
    kind: 'action',
    domain: 'shop',
    description: 'Place an order',
    input: z.object({ orderRef: z.string(), note: z.string().optional() }),
    output: z.object({ orderId: z.string() }),
    access: { roles: ['admin'] },
    effects: { data: ['orders'], events: [], external: [], ai: false },
    // The fixture database has no audit table.
    audit: { enabled: false },
    ...(transactional ? {} : { transactional: false }),
    api: {
      operationId: 'ordersCreate',
      method: 'POST',
      path: '/orders',
      idempotency: { required: true, header: 'Idempotency-Key', ttl: '1h' },
    },
    exposeAs: ['api'],
    async handler(ctx, input: { orderRef: string }) {
      const orderId = `${input.orderRef}-${probe.runs.length + 1}`;
      probe.runs.push(orderId);
      const tx = ctx.__runtime?.transactionScope?.db;
      if (tx) {
        await tx.execute(
          sql`INSERT INTO orders (id, order_ref) VALUES (${orderId}, ${input.orderRef})`,
        );
      }
      probe.entered.get(orderId)?.();
      await probe.holds.get(orderId)?.wait;
      return { orderId };
    },
  } as unknown as CapabilityContract;
}

function server(
  db: PostgresJsDatabase,
  capability: CapabilityContract,
  extra: Parameters<typeof createServer>[0] extends infer C ? Partial<C> : never = {},
  leaseMs = 60_000,
): PlumbusServer {
  const capabilities = new CapabilityRegistry();
  capabilities.register(capability);
  const instance = createServer({
    config: config(),
    db,
    capabilities,
    entities: new EntityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    authAdapter,
    idempotencyStore: createDatabaseIdempotencyStore({ leaseMs }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...extra,
  });
  cleanups.push(() => instance.app.close());
  return instance;
}

function post(instance: PlumbusServer, key: string, body: unknown, user = 'u1') {
  return instance.app.inject({
    method: 'POST',
    url: '/api/shop/place-order',
    headers: { authorization: `Bearer ${user}`, 'idempotency-key': key },
    payload: body as Record<string, unknown>,
  });
}

async function rows<T>(db: PostgresJsDatabase, query: ReturnType<typeof sql>): Promise<T[]> {
  return [...((await db.execute(query)) as unknown as T[])];
}

function probe(): Probe {
  return { runs: [], holds: new Map(), entered: new Map() };
}

describe('database idempotency store over HTTP', () => {
  it('runs once and replays the stored answer; another payload under the key is 422', async () => {
    const db = await database('idem_replay', BUSINESS_DDL + requestIdempotencyDdl());
    const state = probe();
    const app = server(db, placeOrder(state));

    const first = await post(app, 'k-1', { orderRef: 'A' });
    const second = await post(app, 'k-1', { orderRef: 'A' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(state.runs).toEqual(['A-1']);

    const conflict = await post(app, 'k-1', { orderRef: 'B' });
    expect(conflict.statusCode).toBe(422);
    expect(state.runs).toEqual(['A-1']);

    const [record] = await rows<{ state: string; payload_hash: string; tenant_scope: string }>(
      db,
      sql`SELECT state, payload_hash, tenant_scope FROM request_idempotency`,
    );
    expect(record).toMatchObject({ state: 'completed', tenant_scope: 'spine' });
    // A sha256 of the canonical request, not the request itself.
    expect(record?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    // Keys never match across callers.
    const otherCaller = await post(app, 'k-1', { orderRef: 'B' }, 'u2');
    expect(otherCaller.statusCode).toBe(200);
    expect(state.runs).toEqual(['A-1', 'B-2']);
  }, 30_000);

  it('answers 409 with Retry-After while the first request runs, then replays it', async () => {
    const db = await database('idem_busy', BUSINESS_DDL + requestIdempotencyDdl());
    const state = probe();
    const held = gate();
    state.holds.set('A-1', held);
    const entered = new Promise<void>((resolve) => state.entered.set('A-1', resolve));
    // Two server copies on one database: the retry lands on the other one.
    const copyA = server(db, placeOrder(state));
    const copyB = server(db, placeOrder(state));

    const first = post(copyA, 'k-busy', { orderRef: 'A' });
    await entered;
    const retry = await post(copyB, 'k-busy', { orderRef: 'A' });
    expect(retry.statusCode).toBe(409);
    expect(Number(retry.headers['retry-after'])).toBeGreaterThan(0);
    expect(retry.json().error.metadata.reason).toBe('idempotency-in-progress');

    held.open();
    expect((await first).statusCode).toBe(200);
    const replay = await post(copyB, 'k-busy', { orderRef: 'A' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ data: { orderId: 'A-1' } });
    expect(state.runs).toEqual(['A-1']);
  }, 30_000);

  it('re-runs a request whose claim lapsed without a completion (the claiming process died)', async () => {
    const db = await database('idem_lapsed', BUSINESS_DDL + requestIdempotencyDdl());
    const state = probe();
    const app = server(db, placeOrder(state));
    // A process claimed the key, then died before its business transaction committed.
    const dead = createDatabaseIdempotencyStore({ leaseMs: 60_000 });
    const principal = { userId: 'u1' };
    const input = { orderRef: 'A' };
    const authority = hashPayload({ roles: ['admin'], scopes: [] });
    const claimed = await dead.claim(
      buildIdempotencyStoreKey('ordersCreate', principal, 'k-lapsed'),
      hashPayload({ input, authority }),
      principal,
      { database: db, plane: 'spine' },
    );
    expect(claimed.status).toBe('new');

    // Within the lease: the retry is told to come back.
    const early = await post(app, 'k-lapsed', input);
    expect(early.statusCode).toBe(409);
    expect(state.runs).toEqual([]);

    // The lease lapses with no completion: nothing committed, so the request runs.
    await db.execute(
      sql`UPDATE request_idempotency SET lease_expires_at = now() - interval '1 second'`,
    );
    const retried = await post(app, 'k-lapsed', input);
    expect(retried.statusCode).toBe(200);
    expect(state.runs).toEqual(['A-1']);
    expect(await rows(db, sql`SELECT id FROM orders`)).toEqual([{ id: 'A-1' }]);
  }, 30_000);

  it('commits the completion with the business writes: a run overtaken by a retry rolls back', async () => {
    const db = await database('idem_atomic', BUSINESS_DDL + requestIdempotencyDdl());
    const state = probe();
    const held = gate();
    state.holds.set('A-1', held);
    const entered = new Promise<void>((resolve) => state.entered.set('A-1', resolve));
    const app = server(db, placeOrder(state));

    // The first run has written its order inside its transaction and is still running...
    const slow = post(app, 'k-atomic', { orderRef: 'A' });
    await entered;
    // ...when its lease lapses and a retry takes the key over and completes.
    await db.execute(
      sql`UPDATE request_idempotency SET lease_expires_at = now() - interval '1 second'`,
    );
    const retry = await post(app, 'k-atomic', { orderRef: 'A' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ data: { orderId: 'A-2' } });

    // The first run cannot record its completion, so its whole transaction rolls back.
    held.open();
    const overtaken = await slow;
    expect(overtaken.statusCode).toBe(409);
    expect(await rows(db, sql`SELECT id FROM orders`)).toEqual([{ id: 'A-2' }]);
    const replay = await post(app, 'k-atomic', { orderRef: 'A' });
    expect(replay.json()).toEqual({ data: { orderId: 'A-2' } });
  }, 30_000);

  it('a business failure leaves no completion and releases the key', async () => {
    const db = await database('idem_fail', BUSINESS_DDL + requestIdempotencyDdl());
    const state = probe();
    const failing = {
      ...placeOrder(state),
      async handler(ctx: { __runtime?: { transactionScope?: { db?: PostgresJsDatabase } } }) {
        await ctx.__runtime?.transactionScope?.db?.execute(
          sql`INSERT INTO orders (id, order_ref) VALUES ('X', 'X')`,
        );
        throw new Error('business rule failed after a write');
      },
    } as unknown as CapabilityContract;
    const app = server(db, failing);
    const response = await post(app, 'k-fail', { orderRef: 'A' });
    expect(response.statusCode).toBe(500);
    expect(await rows(db, sql`SELECT id FROM orders`)).toEqual([]);
    expect(await rows(db, sql`SELECT key_hash FROM request_idempotency`)).toEqual([]);
  }, 30_000);

  it('records a non-transactional capability after it returns (documented gap)', async () => {
    const db = await database('idem_plain', BUSINESS_DDL + requestIdempotencyDdl());
    const state = probe();
    const app = server(db, placeOrder(state, false));
    expect((await post(app, 'k-plain', { orderRef: 'A' })).statusCode).toBe(200);
    expect((await post(app, 'k-plain', { orderRef: 'A' })).statusCode).toBe(200);
    expect(state.runs).toEqual(['A-1']);
    const [record] = await rows<{ state: string }>(db, sql`SELECT state FROM request_idempotency`);
    expect(record?.state).toBe('completed');
  }, 30_000);

  it('keeps a tenant request key on the tenant plane, in the framework schema', async () => {
    const spine = await database('idem_spine', requestIdempotencyDdl());
    const tenant = await database(
      'idem_tenant',
      `${BUSINESS_DDL}CREATE SCHEMA core_plumbus;${requestIdempotencyDdl('core_plumbus')}`,
    );
    const state = probe();
    const app = server(spine, placeOrder(state), {
      dataPlaneResolver: createSingleDataPlaneResolver(tenant, { coreSchema: 'core_plumbus' }),
    });
    const first = await post(app, 'k-t', { orderRef: 'A' }, 'u1@tenant-a');
    const second = await post(app, 'k-t', { orderRef: 'A' }, 'u1@tenant-a');
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(state.runs).toEqual(['A-1']);
    expect(
      await rows(tenant, sql`SELECT tenant_scope, state FROM core_plumbus.request_idempotency`),
    ).toEqual([{ tenant_scope: 'tenant-a', state: 'completed' }]);
    expect(await rows(spine, sql`SELECT key_hash FROM request_idempotency`)).toEqual([]);
    expect(await rows(tenant, sql`SELECT id FROM orders`)).toEqual([{ id: 'A-1' }]);
  }, 30_000);

  it('sweeps records past their TTL', async () => {
    const db = await database('idem_sweep', BUSINESS_DDL + requestIdempotencyDdl());
    const state = probe();
    const app = server(db, placeOrder(state));
    await post(app, 'k-old', { orderRef: 'A' });
    await post(app, 'k-new', { orderRef: 'B' });
    await db.execute(
      sql`UPDATE request_idempotency SET expires_at = now() - interval '1 minute'
          WHERE key_hash = (SELECT key_hash FROM request_idempotency ORDER BY created_at LIMIT 1)`,
    );
    expect(await sweepExpiredIdempotencyRecords(db)).toBe(1);
    expect(await rows(db, sql`SELECT count(*)::int AS n FROM request_idempotency`)).toEqual([
      { n: 1 },
    ]);
    // An expired key is free again: the request runs anew.
    await db.execute(sql`UPDATE request_idempotency SET expires_at = now() - interval '1 minute'`);
    expect((await post(app, 'k-new', { orderRef: 'B' })).json()).toEqual({
      data: { orderId: 'B-3' },
    });
  }, 30_000);
});
