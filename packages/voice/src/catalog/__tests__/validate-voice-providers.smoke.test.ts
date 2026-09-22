import { describe, expect, it } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import {
  fakeSttRegistration,
  fakeTtsRegistration,
} from '../../providers/__tests__/fake-registrations.js';
import { createProviderRegistry, validateVoiceProviders } from '../../providers/registry.js';

describe('validateVoiceProviders smoke', () => {
  it('flags missing apiKey when an add-on STT is registered without credentials', () => {
    const voice = defineVoice({
      name: 'sonioxVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'soniox' },
      tts: { provider: 'browser-tts' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    const result = validateVoiceProviders({
      voices: [voice],
      providers: {
        providers: {},
      },
      registry: createProviderRegistry({
        stt: { soniox: fakeSttRegistration('soniox') },
      }),
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

  it('flags field package when registry lacks an add-on provider', () => {
    const voice = defineVoice({
      name: 'addonVoice',
      access: {},
      transport: { provider: 'livekit' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
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
          livekit: {
            url: 'wss://livekit.example.test',
            apiKey: 'lk-key',
            apiSecret: 'lk-secret',
          },
        },
      },
      registry: createProviderRegistry({
        // Descriptor present via fake catalog merge is not enough — transport not registered.
        tts: { 'browser-tts': fakeTtsRegistration('browser-tts') },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'livekit',
          field: 'provider',
          message: expect.stringContaining('createProviderRegistry'),
        }),
      ]),
    );
  });
});
