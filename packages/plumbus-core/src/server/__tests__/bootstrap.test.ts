import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlumbusConfig } from '../../types/config.js';
import type { LoggerService } from '../../types/context.js';

// ── Mocks ──

type AnyFn = (...args: any[]) => any;

vi.mock('fastify', () => {
  const routes = new Map<string, AnyFn>();
  let errorHandler: AnyFn | undefined;
  const closeHooks: AnyFn[] = [];
  const app = {
    get: vi.fn((path: string, handler: AnyFn) => {
      routes.set(path, handler);
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    register: vi.fn(),
    addHook: vi.fn((name: string, handler: AnyFn) => {
      if (name === 'onClose') {
        closeHooks.push(handler);
      }
    }),
    setErrorHandler: vi.fn((handler: AnyFn) => {
      errorHandler = handler;
    }),
    listen: vi.fn(
      async (opts: { host: string; port: number }) => `http://${opts.host}:${opts.port}`,
    ),
    close: vi.fn(async () => {
      for (const hook of closeHooks) {
        await hook();
      }
    }),
    _routes: routes,
    get _errorHandler() {
      return errorHandler;
    },
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

const mockGenerateWithUsage = vi.fn(async () => ({
  data: { answer: 'test' },
  usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  model: 'mock-model',
  provider: 'mock',
  cost: 0,
}));

const mockAIService = {
  recordProviderCost: vi.fn(async () => {}),
  checkProviderCostBudget: vi.fn(),
  generate: vi.fn(async () => ({ answer: 'test' })),
  generateWithUsage: mockGenerateWithUsage,
  streamGenerate: vi.fn(async function* () {
    yield { type: 'done' as const, data: { answer: 'test' } };
  }),
  extract: vi.fn(async () => ({})),
  classify: vi.fn(async () => []),
  retrieve: vi.fn(async () => []),
};

vi.mock('../../ai/ai-service.js', () => ({
  createAIService: vi.fn(() => ({ ...mockAIService })),
  singleProviderConfig: vi.fn((adapter: any, rest: any) => ({
    providers: { [adapter.name]: adapter },
    defaultProvider: adapter.name,
    ...rest,
  })),
}));

vi.mock('../../ai/provider.js', () => ({
  createProviderAdapter: vi.fn((name: string) => ({ name })),
}));

vi.mock('../../ai/cost-tracker.js', () => ({
  createCostTracker: vi.fn(() => ({
    checkBudget: vi.fn(() => ({ allowed: true })),
    record: vi.fn(),
  })),
}));

import { createAIService } from '../../ai/ai-service.js';
import { registerAllRoutes } from '../../api/route-generator.js';
import { EntityRegistry } from '../../data/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { EventRegistry } from '../../events/registry.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { TranslationDefinition } from '../../types/translation.js';
import type { ServerConfig } from '../bootstrap.js';
import { createServer } from '../bootstrap.js';
import { GENERIC_INTERNAL_MESSAGE } from '../../errors/http.js';
import { createMemoryCredentialCatalog } from '../../credentials/catalog.js';

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
    auth: { provider: 'jwt', secret: 'test-secret-placeholder-32chars-min' },
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

const testTranslations: TranslationDefinition[] = [
  {
    name: 'errors',
    defaultLocale: 'en',
    locales: ['en', 'he'],
    messages: {
      en: { maxGenerationAttempts: 'Maximum number of generation attempts reached' },
      he: { maxGenerationAttempts: 'הגעת למספר המרבי של ניסיונות יצירה' },
    },
  },
];

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

    it('keeps an optional credentials catalog on the server and does not log secrets', () => {
      const password = 'smtp-boot-pass-not-for-logs';
      const logger: LoggerService = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const credentials = createMemoryCredentialCatalog({
        types: [
          {
            id: 'smtp',
            fields: [
              { name: 'host', secret: false },
              { name: 'password', secret: true },
            ],
          },
        ],
        resolve: () => ({ host: 'mail.test', password }),
      });
      credentials.bind({
        name: 'outbound-mail',
        typeId: 'smtp',
        ref: 'secret:smtp/outbound-mail#r1',
      });

      const server = createServer(makeServerConfig({ credentials, logger }));
      expect(server.credentials).toBe(credentials);
      expect(createServer(makeServerConfig()).credentials).toBeUndefined();

      const logged = JSON.stringify([
        logger.debug.mock.calls,
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
      ]);
      expect(logged).not.toContain(password);
    });

    it('wires a filesystem governed artifact store onto request dependencies without dropping credentials', () => {
      const password = 'smtp-boot-pass-not-for-logs';
      const logger: LoggerService = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const credentials = createMemoryCredentialCatalog({
        types: [
          {
            id: 'smtp',
            fields: [
              { name: 'host', secret: false },
              { name: 'password', secret: true },
            ],
          },
        ],
        resolve: () => ({ host: 'mail.test', password }),
      });
      credentials.bind({
        name: 'outbound-mail',
        typeId: 'smtp',
        ref: 'secret:smtp/outbound-mail#r1',
      });
      const directory = mkdtempSync(join(tmpdir(), 'plumbus-server-artifacts-'));
      try {
        const server = createServer(
          makeServerConfig({ credentials, logger, artifactsDirectory: directory }),
        );
        expect(server.credentials).toBe(credentials);
        expect(server.artifacts).toBeDefined();
        const published = server.artifacts?.publish({
          kind: 'prompt',
          id: 'boot.prompt',
          body: 'Keep this text.',
        });
        expect(published?.digest).toMatch(/^[0-9a-f]{64}$/);
        const routeConfig = (registerAllRoutes as any).mock.calls.at(-1)?.[2];
        const deps = routeConfig?.createDependencies({
          userId: 'user-1',
          tenantId: 'tenant-1',
          roles: ['admin'],
          scopes: [],
          provider: 'test',
        });
        expect(deps.artifacts).toBe(server.artifacts);
        expect(JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls])).not.toContain(
          password,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('leaves artifacts unwired when the default directory is absent', () => {
      const server = createServer(makeServerConfig());
      expect(server.artifacts).toBeUndefined();
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

    it('refuses to listen without an explicit port', async () => {
      const server = createServer(makeServerConfig());
      await expect(server.start()).rejects.toThrow(/createServer\(\{ port \}\) is required/);
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

  describe('custom route hooks', () => {
    it('passes the live DB connection to onRoutesRegistered', () => {
      const db = { execute: vi.fn() } as any;
      const onRoutesRegistered = vi.fn();

      createServer(
        makeServerConfig({
          db,
          onRoutesRegistered,
        }),
      );

      expect(onRoutesRegistered).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ db }),
      );
    });

    it('injects discovered translations into request dependencies', () => {
      createServer(
        makeServerConfig({
          translations: testTranslations,
        }),
      );

      const routeConfigArg = (registerAllRoutes as any).mock.calls.at(-1)?.[2];
      expect(routeConfigArg).toBeDefined();

      const deps = routeConfigArg.createDependencies({
        userId: 'user-1',
        tenantId: 'tenant-1',
        roles: ['admin'],
        scopes: [],
        provider: 'test',
      });

      expect(deps.translations?.t('errors.maxGenerationAttempts')).toBe(
        'Maximum number of generation attempts reached',
      );
    });
  });

  describe('trustProxy', () => {
    it('passes trustProxy to Fastify when set', async () => {
      const Fastify = (await import('fastify')).default;
      createServer(makeServerConfig({ trustProxy: true }));
      expect(Fastify).toHaveBeenCalledWith(expect.objectContaining({ trustProxy: true }));
    });

    it('does not include trustProxy when not set', async () => {
      const Fastify = (await import('fastify')).default;
      createServer(makeServerConfig());
      const callArg = (Fastify as any).mock.calls.at(-1)?.[0];
      expect(callArg).not.toHaveProperty('trustProxy');
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
      ).toThrow('auth.secret is required outside development');
    });

    it('does not throw in production with custom authAdapter and no secret', () => {
      expect(() =>
        createServer(
          makeServerConfig({
            config: makeConfig({
              environment: 'production',
              auth: { provider: 'jwt' },
            }),
            authAdapter: { authenticate: vi.fn(async () => null) },
          }),
        ),
      ).not.toThrow();
    });

    it('does not throw in production with authenticationRuntime and no secret', () => {
      expect(() =>
        createServer(
          makeServerConfig({
            config: makeConfig({
              environment: 'production',
              auth: { provider: 'jwt' },
            }),
            authenticationRuntime: {
              authenticator: { authenticate: vi.fn(async () => ({ status: 'anonymous' })) },
              initialize: vi.fn(async () => {}),
              registerRoutes: vi.fn(),
            },
          }),
        ),
      ).not.toThrow();
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

  describe('resolveAiOverrides', () => {
    function makeAiConfig(): Partial<PlumbusConfig> {
      return {
        aiProviders: {
          defaultProvider: 'openai',
          defaultModel: 'gpt-4o-mini',
          providers: {
            openai: {
              provider: 'openai',
              apiKey: 'test-key',
              model: 'gpt-4o-mini',
            },
          },
        },
      };
    }

    it('creates AI service with defaultModel and promptOverrides from config', () => {
      const aiProviders = {
        defaultProvider: 'openai',
        defaultModel: 'gpt-4o',
        providers: {
          openai: { provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' },
        },
        promptOverrides: {
          interview_ask_next_question: { model: 'gpt-4o-mini', temperature: 0.5 },
        },
      };
      createServer(
        makeServerConfig({
          config: makeConfig({ aiProviders }),
        }),
      );
      expect(createAIService).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultModel: 'gpt-4o',
          promptOverrides: {
            interview_ask_next_question: { model: 'gpt-4o-mini', temperature: 0.5 },
          },
        }),
      );
    });

    it('wraps AI service when resolveAiOverrides is provided', () => {
      const resolver = vi.fn(async () => ({
        defaultModel: 'gpt-4o',
        promptOverrides: { test_prompt: { model: 'gpt-4o' } },
      }));
      const server = createServer(
        makeServerConfig({
          config: makeConfig(makeAiConfig()),
          resolveAiOverrides: resolver,
        }),
      );
      // The server should be created successfully with the resolver
      expect(server).toBeDefined();
    });

    it('sanitizes 5xx messages in Fastify error handler when onProcessError is set', async () => {
      const onProcessError = vi.fn(async () => {});
      const server = createServer(makeServerConfig({ onProcessError }));
      const handler = (server.app as { _errorHandler?: AnyFn })._errorHandler;
      expect(handler).toBeDefined();

      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };
      const err = Object.assign(new Error('secret database connection string'), {
        statusCode: 500,
      });
      await handler?.(err, { url: '/x', method: 'GET', ip: '127.0.0.1' }, reply);

      expect(reply.send).toHaveBeenCalledWith({
        error: { code: 'internal', message: GENERIC_INTERNAL_MESSAGE },
      });
    });

    it('returns original message for 4xx in Fastify error handler', async () => {
      const onProcessError = vi.fn(async () => {});
      const server = createServer(makeServerConfig({ onProcessError }));
      const handler = (server.app as { _errorHandler?: AnyFn })._errorHandler;

      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };
      const err = Object.assign(new Error('bad request detail'), { statusCode: 400 });
      await handler?.(err, { url: '/x', method: 'GET', ip: '127.0.0.1' }, reply);

      expect(reply.send).toHaveBeenCalledWith({
        error: { code: 'internal', message: 'bad request detail' },
      });
    });

    it('calls resolver with DB before AI generate', async () => {
      const db = { execute: vi.fn(async () => []) } as any;
      const resolver = vi.fn(async () => ({
        defaultModel: 'gpt-4o',
      }));
      createServer(
        makeServerConfig({
          config: makeConfig(makeAiConfig()),
          db,
          resolveAiOverrides: resolver,
        }),
      );

      // Get the routeConfig from registerAllRoutes call to exercise the AI service
      const routeConfigArg = (registerAllRoutes as any).mock.calls.at(-1)?.[2];
      expect(routeConfigArg).toBeDefined();

      const deps = routeConfigArg.createDependencies({
        userId: 'user-1',
        tenantId: 'tenant-1',
        roles: ['admin'],
        permissions: [],
      });

      // Calling AI should trigger the resolver
      await deps.ai.generateWithUsage({ prompt: 'test', input: {} });
      expect(resolver).toHaveBeenCalledWith(db);
    });
  });

  describe('authenticationRuntime', () => {
    it('registers runtime plugin and passes requestAuthenticator to routes', async () => {
      const initialize = vi.fn(async () => {});
      const registerRoutes = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const authenticator = { authenticate: vi.fn(async () => ({ status: 'anonymous' })) };

      const server = createServer(
        makeServerConfig({
          authenticationRuntime: {
            authenticator,
            initialize,
            registerRoutes,
            close,
            describeHealth: () => ({ status: 'ok', providers: { cognito: 'available' } }),
          },
        }),
      );

      expect(server.app.register).toHaveBeenCalled();
      const plugin = (server.app.register as any).mock.calls[0]?.[0];
      expect(typeof plugin).toBe('function');
      await plugin(server.app);
      expect(initialize).toHaveBeenCalled();
      expect(registerRoutes).toHaveBeenCalledWith(server.app);

      expect(registerAllRoutes).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ requestAuthenticator: authenticator }),
      );

      await server.stop();
      expect(close).toHaveBeenCalled();
    });

    it('includes auth health component when describeHealth is present', async () => {
      const server = createServer(
        makeServerConfig({
          authenticationRuntime: {
            authenticator: { authenticate: vi.fn(async () => ({ status: 'anonymous' })) },
            initialize: vi.fn(async () => {}),
            registerRoutes: vi.fn(),
            describeHealth: () => ({ status: 'degraded', providers: { cognito: 'unavailable' } }),
          },
        }),
      );
      const routes = (server.app as any)._routes as Map<string, AnyFn>;
      const healthHandler = routes.get('/health');
      const response = await healthHandler?.();
      expect(response.components.auth).toEqual({
        status: 'degraded',
        providers: { cognito: 'unavailable' },
      });
    });
  });
});
