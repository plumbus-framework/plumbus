import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it } from 'vitest';
import { ELEVENLABS_TTS_REGISTRATION } from '../elevenlabs-tts.js';

describe('ElevenLabs TTS provider contract', () => {
  it('uses inline-text-tags delivery for eleven_v3', () => {
    const registry = createProviderRegistry({
      tts: { elevenlabs: ELEVENLABS_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          elevenlabs: { apiKey: 'eleven-key', baseUrl: 'https://api.elevenlabs.test' },
        },
      },
      voiceSlice: {
        provider: 'elevenlabs',
        model: 'eleven_v3',
        voiceId: 'voice-v3',
        locale: 'he-IL',
      },
    });

    expect(provider.capabilities.deliveryMode).toBe('inline-text-tags');
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.applyDeliveryToText?.('Hello', { emotion: 'sad', energy: 'low' })).toContain(
      '[sad]',
    );
    const mapped = provider.mapDeliveryTone({ emotion: 'sad', energy: 'low' });
    expect(mapped).toMatchObject({
      model: 'eleven_v3',
      tags: expect.arrayContaining(['[sad]', '[calm]']),
    });
  });

  it('uses native-params delivery for flash models', () => {
    const registry = createProviderRegistry({
      tts: { elevenlabs: ELEVENLABS_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          elevenlabs: { apiKey: 'eleven-key', baseUrl: 'https://api.elevenlabs.test' },
        },
      },
      voiceSlice: {
        provider: 'elevenlabs',
        model: 'eleven_flash_v2_5',
        voiceId: 'voice-flash',
        locale: 'en-US',
      },
    });

    expect(provider.capabilities.deliveryMode).toBe('native-params');
    const mapped = provider.mapDeliveryTone({
      pace: 'fast',
      warmth: 'high',
      energy: 'medium',
    });
    expect(mapped).toMatchObject({
      model: 'eleven_flash_v2_5',
      voiceId: 'voice-flash',
      speed: expect.any(Number),
      stability: expect.any(Number),
      similarityBoost: expect.any(Number),
    });
    expect(mapped).not.toHaveProperty('tags');
  });

  it('rejects Hebrew locale on flash models', () => {
    const registry = createProviderRegistry({
      tts: { elevenlabs: ELEVENLABS_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          elevenlabs: { apiKey: 'eleven-key', baseUrl: 'https://api.elevenlabs.test' },
        },
      },
      voiceSlice: {
        provider: 'elevenlabs',
        model: 'eleven_flash_v2_5',
        voiceId: 'voice-flash',
        locale: 'he-IL',
      },
    });

    expect(() => provider.mapDeliveryTone({})).toThrow(/flash does not support Hebrew/i);
  });
});
