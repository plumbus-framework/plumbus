import { describe, expect, it } from 'vitest';
import { resolveVoiceProvidersFromEnv } from '../resolve-voice-providers.js';

describe('resolveVoiceProvidersFromEnv', () => {
  it('fills builtin provider slots and preserves explicit configured credentials', () => {
    const providers = resolveVoiceProvidersFromEnv({
      voice: {
        providers: {
          websocket: {},
          'custom-stt': { apiKey: 'stt-key' },
        },
      },
    });

    expect(providers.providers.websocket).toEqual({});
    expect(providers.providers['web-speech']).toEqual({});
    expect(providers.providers['browser-tts']).toEqual({});
    expect(providers.providers['custom-stt']).toEqual({ apiKey: 'stt-key' });
    expect(providers.providers.openai).toBeUndefined();
  });
});
