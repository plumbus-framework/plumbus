import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    start: vi.fn(async () => 'http://0.0.0.0:3000'),
    stop: vi.fn(async () => {}),
  })),
}));

import { createServer } from '../../server/bootstrap.js';
import { runDev, startDevServer } from '../commands/dev.js';
import { discoverResources } from '../discover.js';

// ── Tests ──

describe('CLI dev command', () => {
  beforeEach(() => {
    // CLI utils use console.log for info/warn and console.error for error
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('runDev', () => {
    it('returns config, validation, and serverUrl', () => {
      const result = runDev({});
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('validation');
      expect(result).toHaveProperty('serverUrl');
    });

    it('defaults to port 3000 and host localhost', () => {
      const result = runDev({});
      expect(result.serverUrl).toBe('http://localhost:3000');
    });

    it('uses custom port from options', () => {
      const result = runDev({ port: '4000' });
      expect(result.serverUrl).toBe('http://localhost:4000');
    });

    it('uses custom host from options', () => {
      const result = runDev({ host: '0.0.0.0' });
      expect(result.serverUrl).toBe('http://0.0.0.0:3000');
    });

    it('uses both custom port and host', () => {
      const result = runDev({ port: '8080', host: '127.0.0.1' });
      expect(result.serverUrl).toBe('http://127.0.0.1:8080');
    });

    it('loads config with development environment', () => {
      const result = runDev({});
      expect(result.config.environment).toBe('development');
    });

    it('config has development database defaults', () => {
      const result = runDev({});
      expect(result.config.database.host).toBe('localhost');
      expect(result.config.database.database).toBe('plumbus_dev');
    });

    it('validation is valid for development defaults', () => {
      const result = runDev({});
      expect(result.validation.valid).toBe(true);
      expect(result.validation.errors).toHaveLength(0);
    });

    it('prints info messages for non-JSON mode', () => {
      runDev({});
      expect(console.log).toHaveBeenCalled();
    });

    it('suppresses info output in JSON mode', () => {
      runDev({ json: true });
      expect(console.log).not.toHaveBeenCalled();
    });

    it('prints server URL info', () => {
      runDev({});
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Server URL'))).toBe(true);
    });

    it('prints database info', () => {
      runDev({});
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Database'))).toBe(true);
    });

    it('prints queue info', () => {
      runDev({});
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Queue'))).toBe(true);
    });

    it('warns when AI provider is not configured', () => {
      runDev({});
      // warn() uses console.log with ⚠ prefix
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('AI provider not configured'))).toBe(true);
    });
  });

  describe('startDevServer', () => {
    beforeEach(() => {
      vi.mocked(createServer).mockClear();
      vi.mocked(discoverResources).mockClear();
    });

    it('calls discoverResources to auto-discover app primitives', async () => {
      await startDevServer({ db: {} });
      expect(discoverResources).toHaveBeenCalled();
    });

    it('passes discovered capabilities to createServer', async () => {
      await startDevServer({ db: {} });
      expect(createServer).toHaveBeenCalled();
      const serverConfig = (createServer as any).mock.calls[0][0];
      expect(serverConfig.capabilities.getAll()).toHaveLength(1);
      expect(serverConfig.capabilities.getAll()[0].name).toBe('testCap');
    });

    it('uses provided db when given', async () => {
      const mockDb = { execute: vi.fn() };
      await startDevServer({ db: mockDb });
      const serverConfig = (createServer as any).mock.calls[0][0];
      expect(serverConfig.db).toBe(mockDb);
    });
  });
});
