import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';
import { PlumbusError } from '../../errors/plumbus-error.js';
import { ErrorCode } from '../../types/enums.js';
import {
  createPooledDataPlaneResolver,
  createSingleDataPlaneResolver,
  DEFAULT_CORE_SCHEMA,
  DEFAULT_PACKAGE_SCHEMA_PREFIX,
  UnknownTenantError,
} from '../data-plane-resolver.js';
import type { DataPlaneConnection, PooledDataPlaneResolverOptions } from '../types.js';

/** A db handle stand-in carrying a label so tests can assert identity. */
function makeDb(label: string): PostgresJsDatabase {
  return { label } as unknown as PostgresJsDatabase;
}

function dbLabel(db: PostgresJsDatabase): string {
  return (db as unknown as { label: string }).label;
}

interface Placement {
  target: string;
  generation?: number;
  coreSchema?: string;
  packageSchemaPrefix?: string;
}

interface ConnectionInfo {
  target: string;
}

interface Host {
  placements: Map<string, Placement>;
  describeCalls: string[];
  connectCalls: string[];
  closedConnections: string[];
  options: PooledDataPlaneResolverOptions<ConnectionInfo>;
}

function createHost(initial: Record<string, Placement>): Host {
  const placements = new Map<string, Placement>(Object.entries(initial));
  const describeCalls: string[] = [];
  const connectCalls: string[] = [];
  const closedConnections: string[] = [];

  const options: PooledDataPlaneResolverOptions<ConnectionInfo> = {
    async describe(tenantRef) {
      describeCalls.push(tenantRef);
      const placement = placements.get(tenantRef);
      if (!placement) return undefined;
      return {
        connectionInfo: { target: placement.target },
        generation: placement.generation,
        coreSchema: placement.coreSchema,
        packageSchemaPrefix: placement.packageSchemaPrefix,
      };
    },
    async connect({ tenantRef, descriptor }) {
      const label = `${tenantRef}@${descriptor.connectionInfo.target}`;
      connectCalls.push(label);
      return {
        db: makeDb(label),
        async close() {
          closedConnections.push(label);
        },
      } satisfies DataPlaneConnection;
    },
    onCloseError: () => {
      // Close failures are asserted explicitly where they are exercised.
    },
  };

  return { placements, describeCalls, connectCalls, closedConnections, options };
}

describe('createSingleDataPlaneResolver', () => {
  it('returns the same database for every tenant reference', async () => {
    const db = makeDb('boot-db');
    const resolver = createSingleDataPlaneResolver(db);

    const first = await resolver.resolve('tenant-a');
    const second = await resolver.resolve('tenant-b');

    expect(first.db).toBe(db);
    expect(second.db).toBe(db);
  });

  it('echoes the requested tenant reference and applies schema defaults', async () => {
    const resolver = createSingleDataPlaneResolver(makeDb('boot-db'));

    const handle = await resolver.resolve('tenant-a');

    expect(handle.tenantRef).toBe('tenant-a');
    expect(handle.coreSchema).toBe(DEFAULT_CORE_SCHEMA);
    expect(handle.packageSchemaPrefix).toBe(DEFAULT_PACKAGE_SCHEMA_PREFIX);
    expect(handle.generation).toBeUndefined();
  });

  it('honors overridden schema names and generation', async () => {
    const resolver = createSingleDataPlaneResolver(makeDb('boot-db'), {
      coreSchema: 'core_runtime',
      packageSchemaPrefix: 'module_',
      generation: 7,
    });

    const handle = await resolver.resolve('tenant-a');

    expect(handle.coreSchema).toBe('core_runtime');
    expect(handle.packageSchemaPrefix).toBe('module_');
    expect(handle.generation).toBe(7);
  });

  it('resolves for callers that carry no tenant reference (current behavior)', async () => {
    const db = makeDb('boot-db');
    const resolver = createSingleDataPlaneResolver(db);

    const handle = await resolver.resolve('');

    expect(handle.db).toBe(db);
    expect(handle.tenantRef).toBe('');
  });

  it('freezes the handle it returns', async () => {
    const resolver = createSingleDataPlaneResolver(makeDb('boot-db'));

    const handle = await resolver.resolve('tenant-a');

    expect(Object.isFrozen(handle)).toBe(true);
  });

  it('exposes no invalidation surface (nothing is cached)', () => {
    const resolver = createSingleDataPlaneResolver(makeDb('boot-db'));

    expect(resolver.invalidate).toBeUndefined();
  });
});

describe('createPooledDataPlaneResolver', () => {
  it('resolves each tenant through the host and caches the result', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    const resolver = createPooledDataPlaneResolver(host.options);

    const first = await resolver.resolve('tenant-a');
    const second = await resolver.resolve('tenant-a');

    expect(first).toBe(second);
    expect(dbLabel(first.db)).toBe('tenant-a@plane-1');
    expect(host.describeCalls).toEqual(['tenant-a']);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1']);
  });

  it('never returns one tenant handle for another tenant', async () => {
    const host = createHost({
      'tenant-a': { target: 'plane-1' },
      'tenant-b': { target: 'plane-2' },
    });
    const resolver = createPooledDataPlaneResolver(host.options);

    const a = await resolver.resolve('tenant-a');
    const b = await resolver.resolve('tenant-b');
    const aAgain = await resolver.resolve('tenant-a');

    expect(a.tenantRef).toBe('tenant-a');
    expect(b.tenantRef).toBe('tenant-b');
    expect(dbLabel(a.db)).toBe('tenant-a@plane-1');
    expect(dbLabel(b.db)).toBe('tenant-b@plane-2');
    expect(a.db).not.toBe(b.db);
    expect(aAgain.db).toBe(a.db);
  });

  it('fails closed on an unknown tenant reference instead of falling back', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    const resolver = createPooledDataPlaneResolver(host.options);

    // Warm the cache so a fallback, if one existed, would have something to
    // fall back to.
    await resolver.resolve('tenant-a');

    await expect(resolver.resolve('tenant-unknown')).rejects.toThrow(UnknownTenantError);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1']);
  });

  it('reports the unknown tenant as a notFound PlumbusError carrying the reference', async () => {
    const host = createHost({});
    const resolver = createPooledDataPlaneResolver(host.options);

    const error = await resolver.resolve('tenant-ghost').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnknownTenantError);
    expect(error).toBeInstanceOf(PlumbusError);
    const plumbusError = error as PlumbusError;
    expect(plumbusError.code).toBe(ErrorCode.NotFound);
    expect(plumbusError.metadata).toMatchObject({ tenantRef: 'tenant-ghost' });
  });

  it('rejects a blank tenant reference', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    const resolver = createPooledDataPlaneResolver(host.options);

    const error = await resolver.resolve('   ').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PlumbusError);
    expect((error as PlumbusError).code).toBe(ErrorCode.Validation);
    expect(host.describeCalls).toEqual([]);
  });

  it('propagates lookup failures and caches nothing', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    let failing = true;
    const resolver = createPooledDataPlaneResolver({
      ...host.options,
      async describe(tenantRef) {
        if (failing) throw new Error('routing lookup unavailable');
        return host.options.describe(tenantRef);
      },
    });

    await expect(resolver.resolve('tenant-a')).rejects.toThrow('routing lookup unavailable');
    expect(host.connectCalls).toEqual([]);

    failing = false;
    const handle = await resolver.resolve('tenant-a');
    expect(dbLabel(handle.db)).toBe('tenant-a@plane-1');
  });

  it('deduplicates concurrent resolutions of the same tenant', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    const resolver = createPooledDataPlaneResolver(host.options);

    const [first, second, third] = await Promise.all([
      resolver.resolve('tenant-a'),
      resolver.resolve('tenant-a'),
      resolver.resolve('tenant-a'),
    ]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1']);
  });

  it('freezes pooled handles', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    const resolver = createPooledDataPlaneResolver(host.options);

    const handle = await resolver.resolve('tenant-a');

    expect(Object.isFrozen(handle)).toBe(true);
  });

  it('rejects a non-positive cache size', () => {
    const host = createHost({});

    expect(() => createPooledDataPlaneResolver({ ...host.options, cacheSize: 0 })).toThrow(
      PlumbusError,
    );
  });
});

describe('createPooledDataPlaneResolver invalidation', () => {
  it('forces re-resolution and closes the superseded connection', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    const resolver = createPooledDataPlaneResolver(host.options);

    const before = await resolver.resolve('tenant-a');
    expect(dbLabel(before.db)).toBe('tenant-a@plane-1');

    host.placements.set('tenant-a', { target: 'plane-2' });
    await resolver.invalidate('tenant-a');

    const after = await resolver.resolve('tenant-a');

    expect(dbLabel(after.db)).toBe('tenant-a@plane-2');
    expect(host.describeCalls).toEqual(['tenant-a', 'tenant-a']);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1', 'tenant-a@plane-2']);
    expect(host.closedConnections).toEqual(['tenant-a@plane-1']);
  });

  it('leaves other tenants cached when one is invalidated', async () => {
    const host = createHost({
      'tenant-a': { target: 'plane-1' },
      'tenant-b': { target: 'plane-2' },
    });
    const resolver = createPooledDataPlaneResolver(host.options);

    const a = await resolver.resolve('tenant-a');
    const b = await resolver.resolve('tenant-b');
    await resolver.invalidate('tenant-a');
    const bAgain = await resolver.resolve('tenant-b');

    expect(bAgain).toBe(b);
    expect(host.closedConnections).toEqual([dbLabel(a.db)]);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1', 'tenant-b@plane-2']);
  });

  it('is a no-op for a tenant that was never resolved', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    const resolver = createPooledDataPlaneResolver(host.options);

    await expect(resolver.invalidate('tenant-a')).resolves.toBeUndefined();
    expect(host.closedConnections).toEqual([]);
  });

  it('discards a connection opened before an invalidation that lands mid-resolution', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    let releaseFirstConnect: (() => void) | undefined;
    let firstConnectStarted: (() => void) | undefined;
    const firstConnectReached = new Promise<void>((resolve) => {
      firstConnectStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirstConnect = resolve;
    });
    let connectAttempts = 0;

    const resolver = createPooledDataPlaneResolver<ConnectionInfo>({
      ...host.options,
      async connect(request) {
        connectAttempts += 1;
        if (connectAttempts === 1) {
          firstConnectStarted?.();
          await gate;
        }
        return host.options.connect(request);
      },
    });

    const pending = resolver.resolve('tenant-a');
    await firstConnectReached;

    // The tenant moves while the first connection is still being opened.
    host.placements.set('tenant-a', { target: 'plane-2' });
    await resolver.invalidate('tenant-a');
    releaseFirstConnect?.();

    const handle = await pending;

    expect(dbLabel(handle.db)).toBe('tenant-a@plane-2');
    expect(host.closedConnections).toEqual(['tenant-a@plane-1']);
    expect(connectAttempts).toBe(2);

    // The cache now serves the post-invalidation data plane.
    const next = await resolver.resolve('tenant-a');
    expect(next).toBe(handle);
  });

  it('invalidateAll drops every cached data plane', async () => {
    const host = createHost({
      'tenant-a': { target: 'plane-1' },
      'tenant-b': { target: 'plane-2' },
    });
    const resolver = createPooledDataPlaneResolver(host.options);

    await resolver.resolve('tenant-a');
    await resolver.resolve('tenant-b');
    await resolver.invalidateAll();

    expect(host.closedConnections).toEqual(['tenant-a@plane-1', 'tenant-b@plane-2']);

    await resolver.resolve('tenant-a');
    expect(host.connectCalls).toEqual(['tenant-a@plane-1', 'tenant-b@plane-2', 'tenant-a@plane-1']);
  });

  it('reports close failures through onCloseError without failing the invalidation', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    const closeErrors: string[] = [];
    const resolver = createPooledDataPlaneResolver<ConnectionInfo>({
      ...host.options,
      async connect(request) {
        return {
          db: makeDb(`${request.tenantRef}@${request.descriptor.connectionInfo.target}`),
          async close() {
            throw new Error('connection already gone');
          },
        };
      },
      onCloseError: ({ tenantRef, error }) => {
        closeErrors.push(`${tenantRef}:${(error as Error).message}`);
      },
    });

    await resolver.resolve('tenant-a');
    await resolver.invalidate('tenant-a');

    expect(closeErrors).toEqual(['tenant-a:connection already gone']);
    const handle = await resolver.resolve('tenant-a');
    expect(dbLabel(handle.db)).toBe('tenant-a@plane-1');
  });
});

describe('createPooledDataPlaneResolver revalidation', () => {
  it('keeps the connection when the generation is unchanged', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1', generation: 4 } });
    let clock = 1_000;
    const resolver = createPooledDataPlaneResolver({
      ...host.options,
      revalidateAfterMs: 500,
      now: () => clock,
    });

    const first = await resolver.resolve('tenant-a');
    clock += 600;
    const second = await resolver.resolve('tenant-a');

    expect(second).toBe(first);
    expect(second.generation).toBe(4);
    expect(host.describeCalls).toEqual(['tenant-a', 'tenant-a']);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1']);
    expect(host.closedConnections).toEqual([]);

    // The revalidation refreshed the deadline: the next call is a cache hit.
    clock += 100;
    const third = await resolver.resolve('tenant-a');
    expect(third).toBe(first);
    expect(host.describeCalls).toEqual(['tenant-a', 'tenant-a']);
  });

  it('reconnects when the generation moves', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1', generation: 4 } });
    let clock = 1_000;
    const resolver = createPooledDataPlaneResolver({
      ...host.options,
      revalidateAfterMs: 500,
      now: () => clock,
    });

    const before = await resolver.resolve('tenant-a');
    host.placements.set('tenant-a', { target: 'plane-restored', generation: 5 });
    clock += 600;
    const after = await resolver.resolve('tenant-a');

    expect(before.generation).toBe(4);
    expect(after.generation).toBe(5);
    expect(dbLabel(after.db)).toBe('tenant-a@plane-restored');
    expect(host.closedConnections).toEqual(['tenant-a@plane-1']);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1', 'tenant-a@plane-restored']);
  });

  it('drops the cached data plane when the tenant disappears', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1', generation: 1 } });
    let clock = 1_000;
    const resolver = createPooledDataPlaneResolver({
      ...host.options,
      revalidateAfterMs: 500,
      now: () => clock,
    });

    await resolver.resolve('tenant-a');
    host.placements.delete('tenant-a');
    clock += 600;

    await expect(resolver.resolve('tenant-a')).rejects.toThrow(UnknownTenantError);
    expect(host.closedConnections).toEqual(['tenant-a@plane-1']);
  });

  it('keeps serving nothing when revalidation lookup fails, and retries next time', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1', generation: 1 } });
    let clock = 1_000;
    let failing = false;
    const resolver = createPooledDataPlaneResolver({
      ...host.options,
      revalidateAfterMs: 500,
      now: () => clock,
      async describe(tenantRef) {
        if (failing) throw new Error('routing lookup unavailable');
        return host.options.describe(tenantRef);
      },
    });

    const first = await resolver.resolve('tenant-a');
    failing = true;
    clock += 600;
    await expect(resolver.resolve('tenant-a')).rejects.toThrow('routing lookup unavailable');
    expect(host.closedConnections).toEqual([]);

    failing = false;
    const second = await resolver.resolve('tenant-a');
    expect(second).toBe(first);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1']);
  });

  it('rebuilds the handle when only the schema namespaces change', async () => {
    const host = createHost({
      'tenant-a': { target: 'plane-1', generation: 2, coreSchema: 'core_one' },
    });
    let clock = 1_000;
    const resolver = createPooledDataPlaneResolver({
      ...host.options,
      revalidateAfterMs: 500,
      now: () => clock,
    });

    const before = await resolver.resolve('tenant-a');
    host.placements.set('tenant-a', {
      target: 'plane-1',
      generation: 2,
      coreSchema: 'core_two',
    });
    clock += 600;
    const after = await resolver.resolve('tenant-a');

    expect(before.coreSchema).toBe('core_one');
    expect(after.coreSchema).toBe('core_two');
    expect(after.db).toBe(before.db);
    expect(host.connectCalls).toEqual(['tenant-a@plane-1']);
    expect(host.closedConnections).toEqual([]);
  });
});

describe('createPooledDataPlaneResolver cache capacity', () => {
  it('evicts and closes the least recently used data plane', async () => {
    const host = createHost({
      'tenant-a': { target: 'plane-1' },
      'tenant-b': { target: 'plane-2' },
      'tenant-c': { target: 'plane-3' },
    });
    const resolver = createPooledDataPlaneResolver({ ...host.options, cacheSize: 2 });

    await resolver.resolve('tenant-a');
    await resolver.resolve('tenant-b');
    await resolver.resolve('tenant-c');

    expect(host.closedConnections).toEqual(['tenant-a@plane-1']);

    const b = await resolver.resolve('tenant-b');
    expect(dbLabel(b.db)).toBe('tenant-b@plane-2');
    expect(host.connectCalls).toEqual(['tenant-a@plane-1', 'tenant-b@plane-2', 'tenant-c@plane-3']);
  });

  it('counts a cache hit as a use for eviction ordering', async () => {
    const host = createHost({
      'tenant-a': { target: 'plane-1' },
      'tenant-b': { target: 'plane-2' },
      'tenant-c': { target: 'plane-3' },
    });
    const resolver = createPooledDataPlaneResolver({ ...host.options, cacheSize: 2 });

    await resolver.resolve('tenant-a');
    await resolver.resolve('tenant-b');
    await resolver.resolve('tenant-a');
    await resolver.resolve('tenant-c');

    expect(host.closedConnections).toEqual(['tenant-b@plane-2']);
  });

  it('re-resolves a tenant that was evicted, never serving a neighbour', async () => {
    const host = createHost({
      'tenant-a': { target: 'plane-1' },
      'tenant-b': { target: 'plane-2' },
    });
    const resolver = createPooledDataPlaneResolver({ ...host.options, cacheSize: 1 });

    await resolver.resolve('tenant-a');
    await resolver.resolve('tenant-b');
    const a = await resolver.resolve('tenant-a');

    expect(dbLabel(a.db)).toBe('tenant-a@plane-1');
    expect(a.tenantRef).toBe('tenant-a');
    expect(host.connectCalls).toEqual(['tenant-a@plane-1', 'tenant-b@plane-2', 'tenant-a@plane-1']);
  });
});

describe('createPooledDataPlaneResolver shutdown', () => {
  it('closes every cached data plane and refuses further resolution', async () => {
    const host = createHost({
      'tenant-a': { target: 'plane-1' },
      'tenant-b': { target: 'plane-2' },
    });
    const resolver = createPooledDataPlaneResolver(host.options);

    await resolver.resolve('tenant-a');
    await resolver.resolve('tenant-b');
    await resolver.close();

    expect(host.closedConnections).toEqual(['tenant-a@plane-1', 'tenant-b@plane-2']);

    const error = await resolver.resolve('tenant-a').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PlumbusError);
    expect((error as PlumbusError).code).toBe(ErrorCode.Internal);
  });

  it('does not cache a connection opened while the resolver was closing', async () => {
    const host = createHost({ 'tenant-a': { target: 'plane-1' } });
    let releaseConnect: (() => void) | undefined;
    let connectStarted: (() => void) | undefined;
    const connectReached = new Promise<void>((resolve) => {
      connectStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });

    const resolver = createPooledDataPlaneResolver<ConnectionInfo>({
      ...host.options,
      async connect(request) {
        connectStarted?.();
        await gate;
        return host.options.connect(request);
      },
    });

    const pending = resolver.resolve('tenant-a');
    await connectReached;
    await resolver.close();
    releaseConnect?.();

    await expect(pending).rejects.toThrow(PlumbusError);
    expect(host.closedConnections).toEqual(['tenant-a@plane-1']);
  });
});
