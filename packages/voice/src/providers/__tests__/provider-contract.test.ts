import { describe, expect, it } from 'vitest';
import {
  createProviderRegistry,
  createSTTProvider,
  createTTSProvider,
  createTransportProvider,
} from '../../index.js';
import type { DeliveryTone } from '../../types/voice.js';

const registry = createProviderRegistry();
const providers = {
  providers: {
    websocket: {},
    'web-speech': {},
    'browser-tts': {},
  },
};

const tone: DeliveryTone = {
  pace: 'fast',
  warmth: 'high',
  energy: 'medium',
  emotion: 'calm',
};

describe('built-in provider contracts', () => {
  it('creates STT provider web-speech', () => {
    const provider = createSTTProvider({
      registry,
      providers,
      voiceSlice: { provider: 'web-speech' },
    });

    provider.connect({ sessionId: 'web-speech-session' });
    provider.onClientTranscript?.({ text: 'shalom', final: true, language: 'he' });

    expect(provider.capabilities.id).toBe('web-speech');
    expect(provider.capabilities.kind).toBe('stt');
    expect(provider.capabilities.execution).toBe('client');
    expect(Array.isArray(provider.usage?.())).toBe(true);
  });

  it('creates TTS provider browser-tts', () => {
    const provider = createTTSProvider({
      registry,
      providers,
      voiceSlice: {
        provider: 'browser-tts',
        voiceId: 'voice-1',
        locale: 'en-US',
      },
    });

    const mapped = provider.mapDeliveryTone(tone);

    expect(provider.capabilities.id).toBe('browser-tts');
    expect(provider.capabilities.kind).toBe('tts');
    expect(provider.capabilities.execution).toBe('client');
    expect(mapped).toBeTruthy();
    expect(typeof provider.synthesizeStream).toBe('undefined');
  });

  it('creates websocket transport', () => {
    const provider = createTransportProvider({
      registry,
      providers,
      voiceSlice: { provider: 'websocket', mode: 'pushToTalk' },
    });

    expect(provider.capabilities.id).toBe('websocket');
    expect(provider.capabilities.kind).toBe('transport');
    expect(typeof provider.publishAudio).toBe('function');
    expect(typeof provider.sendData).toBe('function');
  });
});
