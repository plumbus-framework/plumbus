import { describe, expect, it } from 'vitest';
import { buildVoiceServeContext } from '../voice-serve-context.js';

describe('buildVoiceServeContext', () => {
  it('loads voice definitions and provider config from @plumbus/voice', async () => {
    const ctx = await buildVoiceServeContext();

    expect(ctx.routeConfig).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(Array.isArray(ctx.voices)).toBe(true);
    expect(ctx.providers.providers).toBeDefined();
    expect(typeof ctx.closeDb).toBe('function');
    expect(typeof ctx.closeQueues).toBe('function');

    await ctx.closeQueues();
    await ctx.closeDb();
  });
});
