import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlumbusConfig } from '../../types/config.js';
import type { LoggerService } from '../../types/context.js';

// ── Mocks ──

type AnyFn = (...args: any[]) => any;

vi.mock('fastify', () => {
  const routes = new Map<string, AnyFn>();
  const app = {
    get: vi.fn((path: string, handler: AnyFn) => {
      routes.set(path, handler);
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    register: vi.fn(),
    addHook: vi.fn(),
    listen: vi.fn(
      async (opts: { host: string; port: number }) => `http://${opts.host}:${opts.port}`,
    ),
    close: vi.fn(async () => {}),
    _routes: routes,
  };
  return { default: vi.fn(() => app) };
});

vi.mock('../../auth/adapter.js', () => ({
  createJwtAdapter: vi.fn(() => ({
    authenticate: vi.fn(async () => ({
      userId: 'user-1',
      tenantId: 'tenant-1',
      roles: ['admin'],
      permissions: [],
    })),
  })),
}));

vi.mock('../../audit/service.js', () => ({
  createAuditService: vi.fn(() => ({
    record: vi.fn(async () => {}),
  })),
}));

vi.mock('../../api/route-generator.js', () => ({
  registerAllRoutes: vi.fn(),
}));

import { registerAllRoutes } from '../../api/route-generator.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { ServerConfig } from '../bootstrap.js';
import { createServer } from '../bootstrap.js';

// ── Helpers ──

function makeConfig(overrides?: Partial<PlumbusConfig>): PlumbusConfig {
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
    auth: { provider: 'jwt', secret: 'test-secret' },
    ...overrides,
  };
}

function makeServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    config: makeConfig(),
    db: {} as any,
    capabilities: new CapabilityRegistry(),
    entities: new EntityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    ...overrides,
  };
}

// ── Tests ──

describe('Server Bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createServer', () => {
    it('returns a PlumbusServer with app, start, and stop', () => {
      const server = createServer(makeServerConfig());
      expect(server).toHaveProperty('app');
      expect(server).toHaveProperty('start');
      expect(server).toHaveProperty('stop');
      expect(typeof server.start).toBe('function');
      expect(typeof server.stop).toBe('function');
    });

    it('registers /health endpoint', () => {
      const server = createServer(makeServerConfig());
      expect(server.app.get).toHaveBeenCalledWith('/health', expect.any(Function));
    });

    it('registers /ready endpoint', () => {
      const server = createServer(makeServerConfig());
      expect(server.app.get).toHaveBeenCalledWith('/ready', expect.any(Function));
    });

    it('calls registerAllRoutes with capabilities', () => {
      const caps = new CapabilityRegistry();
      createServer(makeServerConfig({ capabilities: caps }));
      expect(registerAllRoutes).toHaveBeenCalledWith(
        expect.anything(),
        caps.getAll(),
        expect.objectContaining({
          authAdapter: expect.anything(),
          createDependencies: expect.any(Function),
        }),
      );
    });

    it('uses custom port and host for start', async () => {
      const server = createServer(makeServerConfig({ port: 4000, host: '127.0.0.1' }));
      const address = await server.start();
      expect(address).toBe('http://127.0.0.1:4000');
    });

    it('defaults to port 3000 and host 0.0.0.0', async () => {
      const server = createServer(makeServerConfig());
      const address = await server.start();
      expect(address).toBe('http://0.0.0.0:3000');
    });

    it('calls app.close on stop', async () => {
      const server = createServer(makeServerConfig());
      await server.stop();
      expect(server.app.close).toHaveBeenCalled();
    });
  });

  describe('/health handler', () => {
    it('returns status ok with environment and capability count', async () => {
      const server = createServer(makeServerConfig());
      const routes = (server.app as any)._routes as Map<string, AnyFn>;
      const healthHandler = routes.get('/health');
      expect(healthHandler).toBeDefined();

      const response = await healthHandler?.();
      expect(response).toMatchObject({
        status: 'ok',
        environment: 'development',
        capabilities: 0,
      });
      expect(response.timestamp).toBeDefined();
    });

    it('returns correct capability count', async () => {
      const caps = new CapabilityRegistry();
      caps.register({
        name: 'cap1',
        domain: 'test',
        description: 'd',
        input: {} as any,
        handler: async () => ({}),
      } as any);
      const server = createServer(makeServerConfig({ capabilities: caps }));
      const routes = (server.app as any)._routes as Map<string, AnyFn>;
      const healthHandler = routes.get('/health');
      const response = await healthHandler?.();
      expect(response.capabilities).toBe(1);
    });
  });

  describe('/ready handler', () => {
    it('returns ready when DB is reachable', async () => {
      const db = {
        execute: vi.fn(async () => [{ '?column?': 1 }]),
      };
      const server = createServer(makeServerConfig({ db: db as any }));
      const routes = (server.app as any)._routes as Map<string, AnyFn>;
      const readyHandler = routes.get('/ready');

      const response = await readyHandler?.({}, { status: vi.fn().mockReturnThis() });
      expect(response).toEqual({ status: 'ready' });
    });

    it('returns 503 when DB is unreachable', async () => {
      const db = {
        execute: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      };
      const reply = { status: vi.fn().mockReturnThis() };
      const server = createServer(makeServerConfig({ db: db as any }));
      const routes = (server.app as any)._routes as Map<string, AnyFn>;
      const readyHandler = routes.get('/ready');

      const response = await readyHandler?.({}, reply);
      expect(reply.status).toHaveBeenCalledWith(503);
      expect(response).toEqual({ status: 'not_ready', reason: 'database unavailable' });
    });
  });

  describe('custom logger', () => {
    it('uses provided custom logger', () => {
      const customLogger: LoggerService = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      createServer(makeServerConfig({ logger: customLogger }));
      expect(customLogger.info).toHaveBeenCalledWith('Registered 0 capability routes');
    });
  });

  describe('custom auth adapter', () => {
    it('uses provided auth adapter instead of JWT default', () => {
      const customAuth = {
        authenticate: vi.fn(async () => null),
      };
      createServer(makeServerConfig({ authAdapter: customAuth }));
      expect(registerAllRoutes).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ authAdapter: customAuth }),
      );
    });
  });

  describe('production environment', () => {
    it('creates server with production config', () => {
      const server = createServer(
        makeServerConfig({
          config: makeConfig({ environment: 'production' }),
        }),
      );
      expect(server).toBeDefined();
      expect(server.app).toBeDefined();
    });

    it('throws when no auth secret is provided in production', () => {
      expect(() =>
        createServer(
          makeServerConfig({
            config: makeConfig({
              environment: 'production',
              auth: { provider: 'jwt' },
            }),
          }),
        ),
      ).toThrow('auth.secret is required in production');
    });

    it('does not throw in development when no auth secret is provided', () => {
      expect(() =>
        createServer(
          makeServerConfig({
            config: makeConfig({
              environment: 'development',
              auth: { provider: 'jwt' },
            }),
          }),
        ),
      ).not.toThrow();
    });
  });
});
