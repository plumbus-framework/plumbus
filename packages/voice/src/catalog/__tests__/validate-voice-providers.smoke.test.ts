import { describe, expect, it } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import { validateVoiceProviders } from '../../providers/registry.js';

describe('validateVoiceProviders smoke', () => {
  it('flags missing soniox.apiKey for a soniox-backed voice', () => {
    const voice = defineVoice({
      name: 'sonioxVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'soniox' },
      tts: { provider: 'openai', model: 'tts-1', voiceId: 'alloy' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    const result = validateVoiceProviders({
      voices: [voice],
      providers: {
        providers: {
          openai: { apiKey: 'openai-key' },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'soniox',
          field: 'apiKey',
        }),
      ]),
    );
  });
});
