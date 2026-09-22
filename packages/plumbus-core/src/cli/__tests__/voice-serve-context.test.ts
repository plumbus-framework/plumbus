import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderRegistry } from '@plumbus/voice';

vi.mock('@plumbus/voice', async () => {
  const actual = await vi.importActual<typeof import('@plumbus/voice')>('@plumbus/voice');
  return {
    ...actual,
    discoverVoices: async () => [],
    loadAppVoiceRegistry: async () => ({
      registry: createProviderRegistry(),
      providers: { providers: {} },
    }),
  };
});

import { buildVoiceServeContext } from '../voice-serve-context.js';

describe('buildVoiceServeContext', () => {
  beforeEach(() => {
    vi.stubEnv('PLUMBUS_ENV', 'development');
    vi.stubEnv('AUTH_SECRET', undefined);
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
});
