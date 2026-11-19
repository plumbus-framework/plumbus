// Leases on the pooled data-plane resolver: a plane in use is never closed, the number of
// open connections never passes `cacheSize`, and a full cache waits (bounded) then refuses.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';
import {
  acquireDataPlane,
  createPooledDataPlaneResolver,
  createSingleDataPlaneResolver,
  DataPlaneCapacityError,
  withDataPlane,
} from '../data-plane-resolver.js';
import type { DataPlaneResolver } from '../types.js';

interface FakeConnection {
  tenantRef: string;
  serial: number;
  closed: boolean;
  /** A query on this plane: throws once the connection was closed, like postgres.js. */
  use(): void;
}

/** Fake `connect`/`close` that records how many connections are open at once. */
function fakePlanes() {
  let serial = 0;
  let open = 0;
  let maxOpen = 0;
  const closes: string[] = [];
  const connections: FakeConnection[] = [];
  return {
    get open() {
      return open;
    },
    get maxOpen() {
      return maxOpen;
    },
    closes,
    connections,
    describe: async (tenantRef: string) => ({ connectionInfo: tenantRef, generation: 1 }),
    connect: async ({ tenantRef }: { tenantRef: string }) => {
      serial += 1;
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      const connection: FakeConnection = {
        tenantRef,
        serial,
        closed: false,
        use() {
          if (this.closed) throw new Error(`CONNECTION_ENDED (${tenantRef}#${this.serial})`);
        },
      };
      connections.push(connection);
      return {
        db: connection as unknown as PostgresJsDatabase,
        async close() {
          connection.closed = true;
          open -= 1;
          closes.push(`${tenantRef}#${connection.serial}`);
        },
      };
    },
  };
}

function connectionOf(db: PostgresJsDatabase): FakeConnection {
  return db as unknown as FakeConnection;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('pooled resolver leases', () => {
  it('never closes a leased plane to make room: the next tenant waits, then takes the slot of a released one', async () => {
    const planes = fakePlanes();
    const resolver = createPooledDataPlaneResolver({ ...planes, cacheSize: 2 });
    const a = await resolver.acquire('a');
    const b = await resolver.acquire('b');

    let cAcquired = false;
    const c = resolver.acquire('c').then((lease) => {
      cAcquired = true;
      return lease;
    });
    await tick();
    expect(cAcquired).toBe(false);
    expect(planes.closes).toEqual([]);
    expect(resolver.stats()).toMatchObject({ cached: 2, leases: 2, waiting: 1 });

    // Both a and b are still usable while c waits.
    connectionOf(a.handle.db).use();
    connectionOf(b.handle.db).use();

    a.release();
    const cLease = await c;
    expect(planes.closes).toEqual(['a#1']);
    connectionOf(b.handle.db).use();
    connectionOf(cLease.handle.db).use();
    expect(planes.maxOpen).toBe(2);
    b.release();
    cLease.release();
    expect(resolver.stats()).toMatchObject({ leases: 0, waiting: 0 });
  });

  it('refuses with DataPlaneCapacityError when every plane stays leased past the wait, closing and opening nothing', async () => {
    const planes = fakePlanes();
    const resolver = createPooledDataPlaneResolver({ ...planes, cacheSize: 2, capacityWaitMs: 30 });
    const a = await resolver.acquire('a');
    const b = await resolver.acquire('b');

    const refused = await resolver.acquire('c').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DataPlaneCapacityError);
    expect((refused as DataPlaneCapacityError).metadata).toMatchObject({
      tenantRef: 'c',
      cacheSize: 2,
      leases: 2,
      reason: 'data-plane-capacity',
      httpStatus: 503,
    });
    // An unleased resolve gets the same refusal: it must not close a leased plane either.
    await expect(resolver.resolve('d')).rejects.toBeInstanceOf(DataPlaneCapacityError);
    expect(planes.closes).toEqual([]);
    expect(planes.connections.map((connection) => connection.tenantRef)).toEqual(['a', 'b']);
    expect(resolver.stats()).toMatchObject({ waiting: 0, connecting: 0 });

    // A per-call wait overrides the resolver's.
    const started = Date.now();
    await expect(resolver.acquire('c', { waitMs: 0 })).rejects.toBeInstanceOf(
      DataPlaneCapacityError,
    );
    expect(Date.now() - started).toBeLessThan(25);
    a.release();
    b.release();
  });

  it('an aborted wait rejects without touching the planes', async () => {
    const planes = fakePlanes();
    const resolver = createPooledDataPlaneResolver({ ...planes, cacheSize: 1 });
    const a = await resolver.acquire('a');
    const controller = new AbortController();
    const waiting = resolver.acquire('b', { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(waiting).rejects.toThrow('was aborted');
    expect(planes.closes).toEqual([]);
    a.release();
  });

  it('keeps at most cacheSize connections open with many more tenants than slots used concurrently', async () => {
    const planes = fakePlanes();
    const resolver = createPooledDataPlaneResolver({ ...planes, cacheSize: 3 });
    const tenants = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const failures: unknown[] = [];
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        withDataPlane(resolver, tenants[i % tenants.length] ?? 't0', async (handle) => {
          connectionOf(handle.db).use();
          await tick();
          connectionOf(handle.db).use();
        }).catch((error: unknown) => failures.push(error)),
      ),
    );
    expect(failures).toEqual([]);
    expect(planes.maxOpen).toBeLessThanOrEqual(3);
    expect(planes.open).toBeLessThanOrEqual(3);
    expect(resolver.stats()).toMatchObject({ leases: 0, waiting: 0, connecting: 0 });
  });

  it('invalidating a leased plane stops handing it out but closes it only after the last release', async () => {
    const planes = fakePlanes();
    const resolver = createPooledDataPlaneResolver({ ...planes, cacheSize: 2 });
    const held = await resolver.acquire('a');
    await resolver.invalidate('a');
    expect(planes.closes).toEqual([]);
    connectionOf(held.handle.db).use();
    expect(resolver.stats()).toMatchObject({ cached: 0, retired: 1 });

    const fresh = await resolver.acquire('a');
    expect(connectionOf(fresh.handle.db).serial).toBe(2);
    held.release();
    expect(planes.closes).toEqual(['a#1']);
    expect(resolver.stats()).toMatchObject({ cached: 1, retired: 0 });
    fresh.release();
    held.release(); // idempotent
    expect(resolver.stats().leases).toBe(0);
  });

  it('a generation change on a leased plane retires it the same way', async () => {
    const planes = fakePlanes();
    let generation = 1;
    let clock = 0;
    const resolver = createPooledDataPlaneResolver({
      ...planes,
      describe: async (tenantRef) => ({ connectionInfo: tenantRef, generation }),
      cacheSize: 2,
      revalidateAfterMs: 10,
      now: () => clock,
    });
    const held = await resolver.acquire('a');
    generation = 2;
    clock = 20;
    const moved = await resolver.acquire('a');
    expect(connectionOf(moved.handle.db).serial).toBe(2);
    expect(planes.closes).toEqual([]);
    connectionOf(held.handle.db).use();
    held.release();
    expect(planes.closes).toEqual(['a#1']);
    moved.release();
  });

  it('an unleased resolve keeps the old LRU behaviour: the least recently used idle plane is closed', async () => {
    const planes = fakePlanes();
    const resolver = createPooledDataPlaneResolver({ ...planes, cacheSize: 2 });
    const a = await resolver.resolve('a');
    await resolver.resolve('b');
    const leasedB = await resolver.acquire('b');
    await resolver.resolve('c');
    // a was idle and least recently used; b is leased and stays.
    expect(planes.closes).toEqual(['a#1']);
    expect(() => connectionOf(a.db).use()).toThrow('CONNECTION_ENDED');
    connectionOf(leasedB.handle.db).use();
    leasedB.release();
  });

  it('close() ends leased planes too and refuses waiting and later callers', async () => {
    const planes = fakePlanes();
    const resolver = createPooledDataPlaneResolver({ ...planes, cacheSize: 1 });
    const a = await resolver.acquire('a');
    const waiting = resolver.acquire('b');
    await tick();
    await resolver.close();
    await expect(waiting).rejects.toThrow('closed');
    await expect(resolver.acquire('a')).rejects.toThrow('closed');
    expect(planes.closes).toEqual(['a#1']);
    a.release();
    expect(planes.open).toBe(0);
  });

  it('rejects a capacity wait that is not a whole number of milliseconds', () => {
    const planes = fakePlanes();
    expect(() => createPooledDataPlaneResolver({ ...planes, capacityWaitMs: -1 })).toThrow(
      'capacityWaitMs must be a whole number',
    );
  });
});

describe('withDataPlane / acquireDataPlane', () => {
  it('releases the lease when the work throws', async () => {
    const planes = fakePlanes();
    const resolver = createPooledDataPlaneResolver({ ...planes, cacheSize: 1 });
    await expect(
      withDataPlane(resolver, 'a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(resolver.stats().leases).toBe(0);
  });

  it('falls back to resolve, passing the purpose, for a host resolver without acquire', async () => {
    const seen: unknown[] = [];
    const db = {} as PostgresJsDatabase;
    const host: DataPlaneResolver = {
      async resolve(tenantRef, options) {
        seen.push(options);
        return { db, tenantRef, coreSchema: 'public', packageSchemaPrefix: 'pkg_' };
      },
    };
    const lease = await acquireDataPlane(host, 'a', { purpose: 'background' });
    expect(lease.handle.db).toBe(db);
    lease.release();
    expect(seen).toEqual([{ purpose: 'background' }]);
  });

  it('the single-database resolver hands out leases over its one database', async () => {
    const db = {} as PostgresJsDatabase;
    const resolver = createSingleDataPlaneResolver(db);
    const lease = await acquireDataPlane(resolver, 't');
    expect(lease.handle).toMatchObject({ db, tenantRef: 't' });
    lease.release();
  });
});
