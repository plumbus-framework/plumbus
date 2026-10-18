import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderRegistry } from '@plumbus/voice/session';

vi.mock('@plumbus/voice/session', async () => {
  const actual =
    await vi.importActual<typeof import('@plumbus/voice/session')>('@plumbus/voice/session');
  return {
    ...actual,
    discoverVoices: async () => [],
    loadAppVoiceRegistry: async () => ({
      registry: createProviderRegistry(),
      providers: { providers: {} },
    }),
  };
});

vi.mock('../../runtime/voice-runtime.js', () => ({ loadVoiceRuntime: vi.fn(async () => null) }));
import { loadVoiceRuntime } from '../../runtime/voice-runtime.js';

import { buildVoiceServeContext } from '../voice-serve-context.js';

describe('buildVoiceServeContext', () => {
  beforeEach(() => {
    vi.stubEnv('PLUMBUS_ENV', 'development');
    vi.stubEnv('AUTH_SECRET', undefined);
    vi.mocked(loadVoiceRuntime).mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads voice definitions, registry, and provider config from @plumbus/voice', async () => {
    const ctx = await buildVoiceServeContext();

    expect(ctx.routeConfig).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(ctx.config.environment).toBe('development');
    expect(Array.isArray(ctx.voices)).toBe(true);
    expect(ctx.registry).toBeDefined();
    expect(ctx.providers.providers).toBeDefined();
    expect(typeof ctx.closeDb).toBe('function');
    expect(typeof ctx.closeQueues).toBe('function');

    await ctx.closeQueues();
    await ctx.closeDb();
  }, 15_000);

  it('rejects missing credentials outside development through the shared bootstrap', async () => {
    vi.stubEnv('PLUMBUS_ENV', 'production');

    await expect(buildVoiceServeContext()).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('MCP serve requires mcp.agents or an explicit AUTH_SECRET'),
    });
  });
  it('uses explicit resources in production without MCP credentials', async () => {
    vi.stubEnv('PLUMBUS_ENV', 'production');
    vi.mocked(loadVoiceRuntime).mockResolvedValue({
      resources: { capabilities: [], entities: [], events: [], prompts: [] },
      extensions: {},
    });
    const ctx = await buildVoiceServeContext();
    expect(ctx.capabilities.getAll()).toEqual([]);
    expect(ctx.jobQueue).toBeUndefined();
    await expect(ctx.routeConfig.authAdapter.authenticate('Bearer forged')).resolves.toBeNull();
    await ctx.closeQueues();
    await ctx.closeDb();
  });

  it('propagates an explicit runtime failure rather than silently doing full discovery', async () => {
    vi.mocked(loadVoiceRuntime).mockRejectedValue(new Error('invalid scoped runtime'));
    await expect(buildVoiceServeContext()).rejects.toThrow('invalid scoped runtime');
  });
});
