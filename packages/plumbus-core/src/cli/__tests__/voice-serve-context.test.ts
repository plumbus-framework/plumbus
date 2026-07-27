import { describe, expect, it, vi } from 'vitest';
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
  it('loads voice definitions, registry, and provider config from @plumbus/voice', async () => {
    const ctx = await buildVoiceServeContext();

    expect(ctx.routeConfig).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(Array.isArray(ctx.voices)).toBe(true);
    expect(ctx.registry).toBeDefined();
    expect(ctx.providers.providers).toBeDefined();
    expect(typeof ctx.closeDb).toBe('function');
    expect(typeof ctx.closeQueues).toBe('function');

    await ctx.closeQueues();
    await ctx.closeDb();
  }, 15_000);
});
