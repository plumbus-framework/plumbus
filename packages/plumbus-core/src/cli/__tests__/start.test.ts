import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    start: vi.fn(async () => 'http://0.0.0.0:3000'),
    stop: vi.fn(async () => {}),
  })),
}));

import { createServer } from '../../server/bootstrap.js';
import { startProductionServer } from '../commands/start.js';
import { discoverResources } from '../discover.js';

describe('CLI start command', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createServer).mockClear();
    vi.mocked(discoverResources).mockClear();
    // Production config requires these
    process.env.DB_PASSWORD = 'test-password';
    process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-for-production';
  });

  it('loads config with production environment', async () => {
    const { server } = await startProductionServer({ db: {} });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.config.environment).toBe('production');
    expect(server).toBeDefined();
  });

  it('defaults host to 0.0.0.0', async () => {
    await startProductionServer({ db: {} });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.host).toBe('0.0.0.0');
  });

  it('defaults port to 3000', async () => {
    await startProductionServer({ db: {} });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.port).toBe(3000);
  });

  it('uses custom port from options', async () => {
    await startProductionServer({ port: '8080', db: {} });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.port).toBe(8080);
  });

  it('uses custom host from options', async () => {
    await startProductionServer({ host: '127.0.0.1', db: {} });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.host).toBe('127.0.0.1');
  });

  it('calls discoverResources', async () => {
    await startProductionServer({ db: {} });
    expect(discoverResources).toHaveBeenCalled();
  });

  it('passes discovered capabilities to createServer', async () => {
    await startProductionServer({ db: {} });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.capabilities.getAll()).toHaveLength(1);
    expect(serverConfig.capabilities.getAll()[0].name).toBe('testCap');
  });

  it('uses provided db when given', async () => {
    const mockDb = { execute: vi.fn() };
    await startProductionServer({ db: mockDb });
    const serverConfig = (createServer as any).mock.calls[0][0];
    expect(serverConfig.db).toBe(mockDb);
  });

  it('returns shutdown function', async () => {
    const { shutdown } = await startProductionServer({ db: {} });
    expect(typeof shutdown).toBe('function');
  });
});
