import { describe, expect, it } from 'vitest';
import { resolveVoiceProvidersFromEnv } from '../resolve-voice-providers.js';

describe('resolveVoiceProvidersFromEnv', () => {
  it('maps env vars into provider credentials', () => {
    const providers = resolveVoiceProvidersFromEnv({
      voice: {
        providers: {
          livekit: {
            url: 'wss://lk.example.test',
            apiKey: 'lk-key',
            apiSecret: 'lk-secret',
          },
        },
      },
    });

    expect(providers.providers.livekit).toEqual({
      url: 'wss://lk.example.test',
      apiKey: 'lk-key',
      apiSecret: 'lk-secret',
    });
  });
});
