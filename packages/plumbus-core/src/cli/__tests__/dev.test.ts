import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock discoverResources before importing dev module
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

vi.mock('../../runtime/queue-factory.js', () => ({
  resolveRuntimeQueues: vi.fn(async () => ({
    events: {},
    flows: {},
    jobs: {},
    backend: 'memory',
    isDurable: false,
    close: vi.fn(async () => {}),
  })),
}));

vi.mock('../../runtime/load-extensions.js', () => ({
  loadServerExtensions: vi.fn(async () => ({})),
}));

vi.mock('../../runtime/start-worker-pool.js', () => ({
  startWorkerPool: vi.fn(async () => ({
    stop: vi.fn(async () => {}),
  })),
}));

import { createServer } from '../../server/bootstrap.js';
import { loadServerExtensions } from '../../runtime/load-extensions.js';
import { startWorkerPool } from '../../runtime/start-worker-pool.js';
import { resolveDevPort, runDev, startDevServer } from '../commands/dev.js';
import { discoverResources } from '../discover.js';

const LISTEN_PORT = '8080';
const ENV_PORT = '9090';
const ORIGINAL_DEV_PORT = process.env.PLUMBUS_DEV_PORT;

function runConfiguredDev(options: Parameters<typeof runDev>[0] = {}): ReturnType<typeof runDev> {
  return runDev({ port: LISTEN_PORT, ...options });
}

// ── Tests ──

describe('CLI dev command', () => {
  beforeEach(() => {
    // CLI utils use console.log for info/warn and console.error for error
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.PLUMBUS_DEV_PORT;
  });

  afterEach(() => {
    if (ORIGINAL_DEV_PORT === undefined) {
      delete process.env.PLUMBUS_DEV_PORT;
    } else {
      process.env.PLUMBUS_DEV_PORT = ORIGINAL_DEV_PORT;
    }
  });

  describe('resolveDevPort', () => {
    it('uses the explicit --port flag', () => {
      expect(resolveDevPort('8080', {})).toBe(8080);
    });

    it('falls back to PLUMBUS_DEV_PORT', () => {
      expect(resolveDevPort(undefined, { PLUMBUS_DEV_PORT: ENV_PORT })).toBe(9090);
    });

    it('prefers the flag over env', () => {
      expect(resolveDevPort('4000', { PLUMBUS_DEV_PORT: ENV_PORT })).toBe(4000);
    });

    it('rejects missing values', () => {
      expect(() => resolveDevPort(undefined, {})).toThrow(/--port is required/);
    });

    it('rejects empty flag and empty env', () => {
      expect(() => resolveDevPort('  ', { PLUMBUS_DEV_PORT: '' })).toThrow(/--port is required/);
    });

    it('rejects non-integer ports', () => {
      expect(() => resolveDevPort('not-a-port', {})).toThrow(/Invalid port/);
    });

    it('rejects out-of-range ports', () => {
      expect(() => resolveDevPort('0', {})).toThrow(/Invalid port/);
      expect(() => resolveDevPort('70000', {})).toThrow(/Invalid port/);
    });
  });

  describe('runDev', () => {
    it('returns config, validation, and serverUrl', () => {
      const result = runConfiguredDev();
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('validation');
      expect(result).toHaveProperty('serverUrl');
      expect(result.port).toBe(8080);
    });

    it('requires --port or PLUMBUS_DEV_PORT', () => {
      expect(() => runDev({})).toThrow(/--port is required/);
    });

    it('uses PLUMBUS_DEV_PORT when --port is omitted', () => {
      process.env.PLUMBUS_DEV_PORT = ENV_PORT;
      const result = runDev({});
      expect(result.serverUrl).toBe(`http://localhost:${ENV_PORT}`);
      expect(result.port).toBe(9090);
    });

    it('uses custom port from options', () => {
      const result = runDev({ port: '4000' });
      expect(result.serverUrl).toBe('http://localhost:4000');
    });

    it('uses custom host from options', () => {
      const result = runConfiguredDev({ host: '0.0.0.0' });
      expect(result.serverUrl).toBe(`http://0.0.0.0:${LISTEN_PORT}`);
    });

    it('uses both custom port and host', () => {
      const result = runDev({ port: '8080', host: '127.0.0.1' });
      expect(result.serverUrl).toBe('http://127.0.0.1:8080');
    });

    it('loads config with development environment', () => {
      const result = runConfiguredDev();
      expect(result.config.environment).toBe('development');
    });

    it('config has development database defaults', () => {
      const result = runConfiguredDev();
      expect(result.config.database.host).toBe('localhost');
      expect(result.config.database.database).toBe('plumbus_dev');
    });

    it('validation is valid for development defaults', () => {
      const result = runConfiguredDev();
      expect(result.validation.valid).toBe(true);
      expect(result.validation.errors).toHaveLength(0);
    });

    it('prints info messages for non-JSON mode', () => {
      runConfiguredDev();
      expect(console.log).toHaveBeenCalled();
    });

    it('suppresses info output in JSON mode', () => {
      runConfiguredDev({ json: true });
      expect(console.log).not.toHaveBeenCalled();
    });

    it('prints server URL info', () => {
      runConfiguredDev();
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Server URL'))).toBe(true);
    });

    it('prints database info', () => {
      runConfiguredDev();
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Database'))).toBe(true);
    });

    it('prints queue info', () => {
      runConfiguredDev();
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Queue'))).toBe(true);
    });

    it('warns when AI provider is not configured', () => {
      runConfiguredDev();
      // warn() uses console.log with ⚠ prefix
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('AI provider not configured'))).toBe(true);
    });
  });

  describe('startDevServer', () => {
    beforeEach(() => {
      vi.mocked(createServer).mockClear();
      vi.mocked(discoverResources).mockClear();
      vi.mocked(startWorkerPool).mockClear();
    });

    it('calls discoverResources to auto-discover app primitives', async () => {
      await startDevServer({ db: {} as never, port: LISTEN_PORT });
      expect(discoverResources).toHaveBeenCalled();
    });

    it('passes discovered capabilities to createServer', async () => {
      await startDevServer({ db: {} as never, port: LISTEN_PORT });
      expect(createServer).toHaveBeenCalled();
      const serverConfig = (createServer as any).mock.calls[0][0];
      expect(serverConfig.capabilities.getAll()).toHaveLength(1);
      expect(serverConfig.capabilities.getAll()[0].name).toBe('testCap');
    });

    it('passes a credentials catalog from server extensions to createServer', async () => {
      const credentials = { id: 'host-catalog' };
      vi.mocked(loadServerExtensions).mockResolvedValueOnce({ credentials } as never);
      await startDevServer({ db: {} as never, port: LISTEN_PORT });
      const serverConfig = (createServer as any).mock.calls[0][0];
      expect(serverConfig.credentials).toBe(credentials);
    });

    it('passes the resolved port to createServer', async () => {
      await startDevServer({ db: {} as never, port: LISTEN_PORT });
      const serverConfig = (createServer as any).mock.calls[0][0];
      expect(serverConfig.port).toBe(8080);
    });

    it('uses PLUMBUS_DEV_PORT when --port is omitted', async () => {
      process.env.PLUMBUS_DEV_PORT = ENV_PORT;
      await startDevServer({ db: {} as never });
      const serverConfig = (createServer as any).mock.calls[0][0];
      expect(serverConfig.port).toBe(9090);
    });

    it('uses provided db when given', async () => {
      const mockDb = { execute: vi.fn() };
      await startDevServer({ db: mockDb as never, port: LISTEN_PORT });
      const serverConfig = (createServer as any).mock.calls[0][0];
      expect(serverConfig.db).toBe(mockDb);
    });

    it('starts the worker pool when flows need background work (C1)', async () => {
      // A flow with an event trigger forces the worker pool to start.
      // evaluateFlowCondition wiring into stepDeps is covered in runtime/bootstrap.test.ts.
      vi.mocked(discoverResources).mockResolvedValueOnce({
        capabilities: [],
        entities: [],
        flows: [
          {
            name: 'flowA',
            domain: 'test',
            trigger: { type: 'event', event: 'test.event' },
            steps: [],
            input: { parse: (v: unknown) => v },
          } as never,
        ],
        events: [],
        prompts: [],
        translations: [],
        eventHandlers: [],
      } as never);

      await startDevServer({ db: { execute: vi.fn() } as never, port: LISTEN_PORT });

      expect(startWorkerPool).toHaveBeenCalled();
    });
  });
});
