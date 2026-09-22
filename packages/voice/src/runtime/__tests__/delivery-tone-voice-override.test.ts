import { describe, expect, it } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import { normalizeResolvedTone } from '../delivery-tone.js';

const voice = defineVoice({
  name: 'toneVariantVoice',
  access: {},
  transport: { provider: 'livekit', mode: 'continuous' },
  stt: { provider: 'mock-stt' },
  tts: { provider: 'mock-tts', voiceId: 'static-voice' },
  toneProfiles: {
    warm: { pace: 'normal', warmth: 'high' },
    apologetic: { pace: 'slow', warmth: 'high', voiceId: 'variant-apologetic' },
  },
  brain: {
    async run() {
      return { text: 'reply' };
    },
  },
});

describe('delivery tone voiceId propagation', () => {
  it('carries a voiceId declared on the tone profile', () => {
    const resolved = normalizeResolvedTone(voice, { profile: 'apologetic' });
    expect(resolved.tone?.voiceId).toBe('variant-apologetic');
  });

  it('carries a voiceId returned by resolveTone, overriding the profile', () => {
    const resolved = normalizeResolvedTone(voice, {
      profile: 'apologetic',
      voiceId: 'variant-override',
    });
    expect(resolved.tone?.voiceId).toBe('variant-override');
  });

  it('leaves voiceId unset for profiles without one (static voice applies)', () => {
    const resolved = normalizeResolvedTone(voice, { profile: 'warm' });
    expect(resolved.tone?.voiceId).toBeUndefined();
  });
});
