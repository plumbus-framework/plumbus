import { describe, expect, it } from 'vitest';
import { defineVoice } from '../defineVoice.js';

describe('defineVoice smoke', () => {
  it('returns a deep-frozen voice definition with kind=voice', () => {
    const voice = defineVoice({
      name: 'guideVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: {
        async run() {
          return { text: 'hello' };
        },
      },
      toneProfiles: {
        calm: { pace: 'slow', warmth: 'high' },
      },
    });

    expect(voice.kind).toBe('voice');
    expect(voice.toneProfiles.calm?.profile).toBe('calm');
    expect(Object.isFrozen(voice)).toBe(true);
    expect(Object.isFrozen(voice.transport)).toBe(true);
  });

  it('throws on invalid config', () => {
    expect(() =>
      defineVoice({
        name: '',
        access: {},
        transport: { provider: 'websocket' },
        stt: { provider: 'web-speech' },
        tts: { provider: 'browser-tts' },
        brain: {
          async run() {
            return { text: 'hello' };
          },
        },
      }),
    ).toThrow(/defineVoice/);
  });
});
