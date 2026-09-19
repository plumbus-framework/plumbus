// ── Flow placement for requests under a data-plane resolver ──
//
// A host that resolves tenant planes may want its requests' repositories on the control
// plane (it routes tenant data itself) while the flows those requests start still land on
// the tenant plane, with only an opaque dispatch hint on the spine. These tests pin the two
// halves of that: which route configuration the server hands the route generator under each
// `requestDataPlane` mode, and what `spineDispatch` the request-side flow engines are built
// with — plus the rule that a `tenantScoped: false` capability reads the control plane
// whatever tenant the request was bound to.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlumbusConfig } from '../../types/config.js';

vi.mock('fastify', () => {
  const app = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    register: vi.fn(),
    addHook: vi.fn(),
    setErrorHandler: vi.fn(),
    listen: vi.fn(
      async (opts: { host: string; port: number }) => `http://${opts.host}:${opts.port}`,
    ),
    close: vi.fn(async () => {}),
  };
  return { default: vi.fn(() => app) };
});

vi.mock('../../auth/adapter.js', () => ({
  createJwtAdapter: vi.fn(() => ({ authenticate: vi.fn(async () => null) })),
}));

vi.mock('../../audit/service.js', () => ({
  createAuditService: vi.fn(() => ({ record: vi.fn(async () => {}) })),
}));

vi.mock('../../api/route-generator.js', () => ({
  registerAllRoutes: vi.fn(),
}));

const createFlowEngine = vi.fn((config: unknown) => ({ config }));
vi.mock('../../flows/engine.js', () => ({
  createFlowEngine: (config: unknown) => createFlowEngine(config),
  generateWorkerId: vi.fn(() => 'test-worker'),
}));

import { registerAllRoutes } from '../../api/route-generator.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { DataPlaneResolver } from '../../tenancy/types.js';
import type { ServerConfig } from '../bootstrap.js';
import { createServer } from '../bootstrap.js';

function makeConfig(): PlumbusConfig {
  return {
    environment: 'development',
    database: {
      host: 'localhost',
      port: 5432,
      database: 'plumbus_dev',
      user: 'postgres',
      password: 'postgres',
      ssl: false,
      poolSize: 5,
    },
    queue: { host: 'localhost', port: 6379, prefix: 'plumbus:dev' },
    auth: { provider: 'jwt', secret: 'test-secret-placeholder-32chars-min' },
  };
}

const controlPlaneDb = { marker: 'control-plane' } as unknown as ServerConfig['db'];
const tenantDb = { marker: 'tenant-a' } as unknown as ServerConfig['db'];

function makeResolver(): DataPlaneResolver {
  return {
    resolve: vi.fn(async (tenantRef: string) => ({
      db: tenantDb as never,
      coreSchema: 'core_plumbus',
      packageSchemaPrefix: 'pkg_',
      tenantRef,
    })),
  };
}

function makeServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    config: makeConfig(),
    db: controlPlaneDb,
    capabilities: new CapabilityRegistry(),
    entities: new EntityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    ...overrides,
  };
}

function routeConfigOf(): Record<string, unknown> {
  const call = vi.mocked(registerAllRoutes).mock.calls.at(-1);
  if (!call) throw new Error('registerAllRoutes was not called');
  return call[2] as Record<string, unknown>;
}

function requestEngineConfig(): Record<string, unknown> {
  const first = createFlowEngine.mock.calls[0];
  if (!first) throw new Error('no request flow engine was created');
  return first[0] as Record<string, unknown>;
}

describe('request flow placement under a data-plane resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds request flow engines without spine dispatch when no resolver is configured', () => {
    createServer(makeServerConfig());
    expect(requestEngineConfig().spineDispatch).toBeUndefined();
    expect(routeConfigOf().resolveDependencies).toBeUndefined();
  });

  it('gives request flow engines spine dispatch on the control plane with the resolver and the untenanted policy', () => {
    const resolver = makeResolver();
    createServer(
      makeServerConfig({ dataPlaneResolver: resolver, untenantedDataPlane: 'control-plane' }),
    );
    expect(requestEngineConfig().spineDispatch).toEqual({
      db: controlPlaneDb,
      resolver,
      untenanted: 'control-plane',
      // The host's framework schema reaches the engine's durable dispatch.
      coreSchema: 'core_plumbus',
    });
  });

  it('keeps repositories on the control plane under requestDataPlane control-plane, while flows are still placed', () => {
    const resolver = makeResolver();
    createServer(
      makeServerConfig({
        dataPlaneResolver: resolver,
        untenantedDataPlane: 'control-plane',
        requestDataPlane: 'control-plane',
      }),
    );
    // No per-request resolution: the route generator builds dependencies on `db` as always.
    expect(routeConfigOf().resolveDependencies).toBeUndefined();
    expect(routeConfigOf().db).toBe(controlPlaneDb);
    // The engine those dependencies carry still places flows through the resolver.
    expect((requestEngineConfig().spineDispatch as { resolver: unknown }).resolver).toBe(resolver);
  });

  it('resolves tenant requests but sends control-plane capabilities to the control plane under requestDataPlane resolved', async () => {
    const resolver = makeResolver();
    createServer(makeServerConfig({ dataPlaneResolver: resolver, untenantedDataPlane: 'refuse' }));
    const resolveDependencies = routeConfigOf().resolveDependencies as (
      auth: Record<string, unknown>,
      options?: { bypassTenantScope?: boolean },
    ) => Promise<{ db: unknown }>;
    expect(typeof resolveDependencies).toBe('function');

    const tenantAuth = {
      userId: 'u',
      tenantId: 'tenant-a',
      roles: [],
      scopes: [],
      provider: 'jwt',
    };
    const tenantBound = await resolveDependencies(tenantAuth);
    expect(tenantBound.db).toBe(tenantDb);

    // `tenantScoped: false` — control-plane work — reads the control plane even when bound.
    const controlPlane = await resolveDependencies(tenantAuth, { bypassTenantScope: true });
    expect(controlPlane.db).toBe(controlPlaneDb);
    expect(vi.mocked(resolver.resolve)).toHaveBeenCalledTimes(1);
  });
});
