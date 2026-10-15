import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock discoverResources before importing start module
vi.mock('../discover.js', () => ({
  discoverResources: vi.fn(async () => ({
    capabilities: [
      {
        name: 'testCap',
        kind: 'query',
        domain: 'test',
        handler: async () => ({}),
        effects: { data: [], events: [], external: [], ai: false },
        input: { parse: (v: unknown) => v },
        output: { parse: (v: unknown) => v },
        access: { roles: ['admin'] },
      },
    ],
    entities: [],
    flows: [],
    events: [],
    prompts: [],
  })),
}));

// Mock server bootstrap
vi.mock('../../server/bootstrap.js', () => ({
  createServer: vi.fn(() => ({
    app: {},
    start: vi.fn(async () => 'http://0.0.0.0:8080'),
    stop: vi.fn(async () => {}),
  })),
}));

const closeQueues = vi.fn(async () => {});

vi.mock('../../runtime/queue-factory.js', () => ({
  resolveRuntimeQueues: vi.fn(async () => ({
    events: {},
    flows: {},
    jobs: {},
    backend: 'memory',
    isDurable: false,
    close: closeQueues,
  })),
}));

vi.mock('../../runtime/start-worker-pool.js', () => ({
  startWorkerPool: vi.fn(async () => ({
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock('../../runtime/load-extensions.js', () => ({
  loadServerExtensions: vi.fn(async () => ({})),
}));

import { createServer } from '../../server/bootstrap.js';
import { loadServerExtensions } from '../../runtime/load-extensions.js';
import { startWorkerPool } from '../../runtime/start-worker-pool.js';
import { resolveStartPort, startProductionServer } from '../commands/start.js';
import { discoverResources } from '../discover.js';

const LISTEN_PORT = '8080';
const ENV_PORT = '9090';
const ORIGINAL_START_PORT = process.env.PLUMBUS_START_PORT;

function startConfigured(
  options: Parameters<typeof startProductionServer>[0] = {},
): ReturnType<typeof startProductionServer> {
  return startProductionServer({ port: LISTEN_PORT, ...options });
}
// startProductionServer installs process signal/error handlers; drop the ones each
// test added so the suite does not exceed Node's default listener limit.
const processEvents = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
let listenersBefore = new Map<string, ((...args: never) => unknown)[]>();

describe('CLI start command', () => {
  afterEach(() => {
    for (const event of processEvents) {
      const before = listenersBefore.get(event) ?? [];
      for (const listener of process.listeners(event)) {
        if (!before.includes(listener)) process.removeListener(event, listener as never);
      }
    }
    if (ORIGINAL_START_PORT === undefined) {
      delete process.env.PLUMBUS_START_PORT;
    } else {
      process.env.PLUMBUS_START_PORT = ORIGINAL_START_PORT;
    }
  });

  beforeEach(() => {
    listenersBefore = new Map(processEvents.map((event) => [event, [...process.listeners(event)]]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createServer).mockClear();
    vi.mocked(discoverResources).mockClear();
    closeQueues.mockClear();
    delete process.env.PLUMBUS_RUNTIME_ROLE;
    delete process.env.PLUMBUS_START_PORT;
    delete process.env.PLUMBUS_SHUTDOWN_TIMEOUT_MS;
    delete process.env.PLUMBUS_SHUTDOWN_DRAIN_DELAY_MS;
    // Production config requires these
    process.env.DB_PASSWORD = 'test-password';
    process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-for-production';
  });

  describe('resolveStartPort', () => {
    it('uses the explicit --port flag', () => {
      expect(resolveStartPort('8080', {})).toBe(8080);
    });

    it('falls back to PLUMBUS_START_PORT', () => {
      expect(resolveStartPort(undefined, { PLUMBUS_START_PORT: ENV_PORT })).toBe(9090);
    });

    it('prefers the flag over env', () => {
      expect(resolveStartPort('4000', { PLUMBUS_START_PORT: ENV_PORT })).toBe(4000);
    });

    it('rejects missing values', () => {
      expect(() => resolveStartPort(undefined, {})).toThrow(/--port is required/);
    });

    it('rejects empty flag and empty env', () => {
      expect(() => resolveStartPort('  ', { PLUMBUS_START_PORT: '' })).toThrow(
        /--port is required/,
      );
    });

    it('rejects non-integer ports', () => {
      expect(() => resolveStartPort('not-a-port', {})).toThrow(/Invalid port/);
    });

    it('rejects out-of-range ports', () => {
      expect(() => resolveStartPort('0', {})).toThrow(/Invalid port/);
      expect(() => resolveStartPort('70000', {})).toThrow(/Invalid port/);
    });
  });

  it('loads config with production environment', async () => {
    const { server } = await startConfigured({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.config.environment).toBe('production');
    expect(server).toBeDefined();
  });

  it('defaults host to 0.0.0.0', async () => {
    await startConfigured({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.host).toBe('0.0.0.0');
  });

  it('requires --port or PLUMBUS_START_PORT', async () => {
    await expect(startProductionServer({ db: {} as never })).rejects.toThrow(/--port is required/);
  });

  it('uses PLUMBUS_START_PORT when --port is omitted', async () => {
    process.env.PLUMBUS_START_PORT = ENV_PORT;
    await startProductionServer({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.port).toBe(9090);
  });

  it('uses custom port from options', async () => {
    await startProductionServer({ port: '8080', db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.port).toBe(8080);
  });

  it('uses custom host from options', async () => {
    await startConfigured({ host: '127.0.0.1', db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.host).toBe('127.0.0.1');
  });

  it('calls discoverResources', async () => {
    await startConfigured({ db: {} as never });
    expect(discoverResources).toHaveBeenCalled();
  });

  it('passes discovered capabilities to createServer', async () => {
    await startConfigured({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.capabilities.getAll()).toHaveLength(1);
    expect(serverConfig.capabilities.getAll()[0].name).toBe('testCap');
  });

  it('passes a credentials catalog from server extensions to createServer', async () => {
    const credentials = { id: 'host-catalog' };
    vi.mocked(loadServerExtensions).mockResolvedValueOnce({ credentials } as never);
    await startConfigured({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.credentials).toBe(credentials);
  });

  it('passes the data-plane resolver family from server extensions to createServer', async () => {
    const dataPlaneResolver = { resolve: vi.fn() };
    vi.mocked(loadServerExtensions).mockResolvedValueOnce({
      dataPlaneResolver,
      untenantedDataPlane: 'control-plane',
      requestDataPlane: 'control-plane',
    } as never);
    await startConfigured({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.dataPlaneResolver).toBe(dataPlaneResolver);
    expect(serverConfig.untenantedDataPlane).toBe('control-plane');
    expect(serverConfig.requestDataPlane).toBe('control-plane');
  });

  it('leaves the resolver family off createServer when the host exports none', async () => {
    await startConfigured({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect('dataPlaneResolver' in serverConfig).toBe(false);
    expect('requestDataPlane' in serverConfig).toBe(false);
  });

  it('uses provided db when given', async () => {
    const mockDb = { execute: vi.fn() };
    await startConfigured({ db: mockDb as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.db).toBe(mockDb);
  });

  it('passes an authenticationRuntime exported from app/server.ts to createServer', async () => {
    const authenticationRuntime = {
      authenticator: {},
      initialize: vi.fn(),
      registerRoutes: vi.fn(),
    };
    vi.mocked(loadServerExtensions).mockResolvedValueOnce({
      authenticationRuntime: authenticationRuntime as never,
    });
    await startConfigured({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.authenticationRuntime).toBe(authenticationRuntime);
  });

  it('passes an idempotencyStore exported from app/server.ts to createServer', async () => {
    const idempotencyStore = {
      kind: 'database',
      claim: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    };
    vi.mocked(loadServerExtensions).mockResolvedValueOnce({ idempotencyStore } as never);
    await startConfigured({ db: {} as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.idempotencyStore).toBe(idempotencyStore);
  });

  it('returns shutdown function', async () => {
    const { shutdown } = await startConfigured({ db: {} as never });
    expect(typeof shutdown).toBe('function');
  });

  it('closes queues on shutdown even when worker pool is not started', async () => {
    process.env.PLUMBUS_RUNTIME_ROLE = 'api';
    const { shutdown } = await startConfigured({ db: {} as never });

    await shutdown();

    expect(closeQueues).toHaveBeenCalledTimes(1);
  });

  it('shuts down in order: readiness off, HTTP, workers with a deadline, onShutdown, queues, DB', async () => {
    process.env.PLUMBUS_SHUTDOWN_TIMEOUT_MS = '4000';
    const order: string[] = [];
    // A job capability makes role `all` start the worker pool.
    vi.mocked(discoverResources).mockResolvedValueOnce({
      capabilities: [
        {
          name: 'testJob',
          kind: 'job',
          domain: 'test',
          handler: async () => ({}),
          effects: { data: [], events: [], external: [], ai: false },
          input: { parse: (v: unknown) => v },
          output: { parse: (v: unknown) => v },
          access: { roles: ['admin'] },
        },
      ],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    } as never);
    vi.mocked(createServer).mockReturnValueOnce({
      app: {},
      start: vi.fn(async () => 'http://0.0.0.0:8080'),
      stop: vi.fn(async () => {
        order.push('http');
      }),
      markShuttingDown: () => order.push('ready-off'),
    } as never);
    const stop = vi.fn(async (_options?: { deadlineAt?: number }) => {
      order.push('workers');
    });
    vi.mocked(startWorkerPool).mockResolvedValueOnce({ stop, flowCycleInFlight: false } as never);
    const onShutdown = vi.fn(async (context: { signal?: string }) => {
      order.push(`hook:${context.signal}`);
    });
    vi.mocked(loadServerExtensions).mockResolvedValueOnce({ onShutdown } as never);
    closeQueues.mockImplementationOnce(async () => {
      order.push('queues');
    });
    const end = vi.fn(async () => {
      order.push('database');
    });

    const { shutdown } = await startConfigured({
      connection: { db: {} as never, sql: { end } as never },
    });
    const before = Date.now();
    await shutdown('SIGTERM');

    expect(order).toEqual(['ready-off', 'http', 'workers', 'hook:SIGTERM', 'queues', 'database']);
    const deadlineAt = stop.mock.calls[0]?.[0]?.deadlineAt ?? 0;
    expect(deadlineAt).toBeGreaterThan(before);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 4_000);
  });

  it('refuses to start with a malformed PLUMBUS_SHUTDOWN_TIMEOUT_MS', async () => {
    process.env.PLUMBUS_SHUTDOWN_TIMEOUT_MS = 'soon';
    await expect(startConfigured({ db: {} as never })).rejects.toThrow(
      /PLUMBUS_SHUTDOWN_TIMEOUT_MS/,
    );
  });

  describe('onBoot in every runtime role', () => {
    const jobResources = {
      capabilities: [
        {
          name: 'testJob',
          kind: 'job',
          domain: 'test',
          handler: async () => ({}),
          effects: { data: [], events: [], external: [], ai: false },
          input: { parse: (v: unknown) => v },
          output: { parse: (v: unknown) => v },
          access: { roles: ['admin'] },
        },
      ],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    };

    // Queue only the implementations the role consumes, so none leaks into the next test.
    function recordStartup(order: string[], servesHttp: boolean, runsWorkers: boolean) {
      vi.mocked(discoverResources).mockResolvedValueOnce(jobResources as never);
      if (servesHttp) {
        vi.mocked(createServer).mockImplementationOnce((() => {
          order.push('server');
          return { app: {}, start: vi.fn(async () => 'http://0.0.0.0:8080'), stop: vi.fn() };
        }) as never);
      }
      if (runsWorkers) {
        vi.mocked(startWorkerPool).mockImplementationOnce((async () => {
          order.push('workers');
          return { stop: vi.fn(async () => {}), flowCycleInFlight: false };
        }) as never);
      }
      const onBoot = vi.fn(async () => {
        order.push('boot');
      });
      vi.mocked(loadServerExtensions).mockResolvedValueOnce({ onBoot } as never);
      return onBoot;
    }

    it.each([
      ['all', ['boot', 'server', 'workers'], true, true],
      ['api', ['boot', 'server'], true, false],
      ['worker', ['boot', 'workers'], false, true],
    ] as const)('role %s: boots once before HTTP and workers', async (role, expected, servesHttp, runsWorkers) => {
      process.env.PLUMBUS_RUNTIME_ROLE = role;
      const order: string[] = [];
      const onBoot = recordStartup(order, servesHttp, runsWorkers);
      const db = { execute: vi.fn() };
      await startConfigured({ db: db as never });
      expect(order).toEqual(expected);
      expect(onBoot).toHaveBeenCalledTimes(1);
      expect(onBoot).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'start', role, servesHttp, runsWorkers, db }),
      );
      const context = onBoot.mock.calls[0]?.[0] as unknown as {
        config: { environment: string };
        logger: { info: unknown };
      };
      expect(context.config.environment).toBe('production');
      expect(typeof context.logger.info).toBe('function');
    });

    it('a worker-only process passes no onRoutesRegistered anywhere and still runs onShutdown', async () => {
      process.env.PLUMBUS_RUNTIME_ROLE = 'worker';
      vi.mocked(discoverResources).mockResolvedValueOnce(jobResources as never);
      const onRoutesRegistered = vi.fn();
      const onShutdown = vi.fn();
      vi.mocked(loadServerExtensions).mockResolvedValueOnce({
        onRoutesRegistered,
        onShutdown,
      } as never);
      const { server, shutdown } = await startConfigured({ db: {} as never });
      expect(server).toBeUndefined();
      expect(createServer).not.toHaveBeenCalled();
      await shutdown('SIGTERM');
      expect(onRoutesRegistered).not.toHaveBeenCalled();
      expect(onShutdown).toHaveBeenCalledWith(expect.objectContaining({ signal: 'SIGTERM' }));
    });

    it('stops startup when onBoot throws: no server, no workers', async () => {
      process.env.PLUMBUS_RUNTIME_ROLE = 'all';
      vi.mocked(discoverResources).mockResolvedValueOnce(jobResources as never);
      vi.mocked(startWorkerPool).mockClear();
      vi.mocked(loadServerExtensions).mockResolvedValueOnce({
        onBoot: async () => {
          throw new Error('release does not verify');
        },
      } as never);
      await expect(startConfigured({ db: {} as never })).rejects.toThrow(
        'App boot (onBoot in app/server.ts) failed: release does not verify',
      );
      expect(createServer).not.toHaveBeenCalled();
      expect(startWorkerPool).not.toHaveBeenCalled();
    });
  });
});
