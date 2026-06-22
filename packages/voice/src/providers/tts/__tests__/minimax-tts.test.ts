import { describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../../registry.js';
import { createTTSProvider } from '../../factory.js';
import type { DeliveryTone } from '../../../types/voice.js';

const tone: DeliveryTone = {
  pace: 'fast',
  warmth: 'high',
  energy: 'medium',
  emotion: 'calm',
};

describe('MiniMax TTS adapter', () => {
  it('maps full delivery tone axes and language boost for Hebrew locales', () => {
    const registry = createProviderRegistry();
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          minimax: { apiKey: 'minimax-key', baseUrl: 'https://api.minimax.test' },
        },
      },
      voiceSlice: {
        provider: 'minimax',
        model: 'speech-2.8-turbo',
        voiceId: 'voice-1',
        locale: 'he-IL',
      },
    });

    const mapped = provider.mapDeliveryTone(tone);
    expect(mapped).toMatchObject({
      model: 'speech-2.8-turbo',
      voiceId: 'voice-1',
      speed: expect.any(Number),
      pitch: expect.any(Number),
      vol: expect.any(Number),
      emotion: expect.any(String),
      languageBoost: 'Hebrew',
    });
  });
});
