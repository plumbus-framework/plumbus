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

describe('CLI start command', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createServer).mockClear();
    vi.mocked(discoverResources).mockClear();
    closeQueues.mockClear();
    delete process.env.PLUMBUS_RUNTIME_ROLE;
    delete process.env.PLUMBUS_START_PORT;
    // Production config requires these
    process.env.DB_PASSWORD = 'test-password';
    process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-for-production';
  });

  afterEach(() => {
    if (ORIGINAL_START_PORT === undefined) {
      delete process.env.PLUMBUS_START_PORT;
    } else {
      process.env.PLUMBUS_START_PORT = ORIGINAL_START_PORT;
    }
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

  it('uses provided db when given', async () => {
    const mockDb = { execute: vi.fn() };
    await startConfigured({ db: mockDb as never });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.db).toBe(mockDb);
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
});
