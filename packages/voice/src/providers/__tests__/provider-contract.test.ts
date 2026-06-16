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
    livekit: {
      url: 'wss://livekit.example.test',
      apiKey: 'lk-key',
      apiSecret: 'lk-secret',
    },
    websocket: {},
    soniox: { apiKey: 'soniox-key' },
    'openai-whisper': { apiKey: 'openai-key', baseUrl: 'https://api.openai.test/v1' },
    'openai-realtime': { apiKey: 'openai-key', baseUrl: 'https://api.openai.test/v1' },
    'web-speech': {},
    deepdub: { apiKey: 'deepdub-key', baseUrl: 'https://api.deepdub.test' },
    openai: { apiKey: 'openai-key', baseUrl: 'https://api.openai.test/v1' },
    minimax: { apiKey: 'minimax-key', baseUrl: 'https://api.minimax.test' },
    elevenlabs: { apiKey: 'elevenlabs-key', baseUrl: 'https://api.elevenlabs.test' },
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
  it.each([
    { providerId: 'soniox', model: undefined, execution: 'server' },
    { providerId: 'openai-whisper', model: 'whisper-1', execution: 'server' },
    { providerId: 'openai-realtime', model: 'gpt-realtime-whisper', execution: 'server' },
    { providerId: 'web-speech', model: undefined, execution: 'client' },
  ])('creates STT provider $providerId', ({ providerId, model, execution }) => {
    const provider = createSTTProvider({
      registry,
      providers,
      voiceSlice: { provider: providerId, model },
    });

    provider.connect({ sessionId: `${providerId}-session` });
    if (providerId === 'openai-whisper') {
      provider.sendAudio?.({
        chunk: new Uint8Array(32_000),
        contentType: 'pcm16;rate=16000;channels=1',
      });
    }
    if (providerId === 'web-speech') {
      provider.onClientTranscript?.({ text: 'shalom', final: true, language: 'he' });
    }

    expect(provider.capabilities.id).toBe(providerId);
    expect(provider.capabilities.kind).toBe('stt');
    expect(provider.capabilities.execution).toBe(execution);
    expect(Array.isArray(provider.usage?.())).toBe(true);
  });

  it.each([
    { providerId: 'deepdub', model: 'dd-etts-3.0', execution: 'server' },
    { providerId: 'openai', model: 'tts-1', execution: 'server' },
    { providerId: 'minimax', model: 'speech-2.8-turbo', execution: 'server' },
    { providerId: 'browser-tts', model: undefined, execution: 'client' },
    { providerId: 'elevenlabs', model: 'eleven_flash_v2_5', execution: 'server' },
  ])('creates TTS provider $providerId', async ({ providerId, model, execution }) => {
    const provider = createTTSProvider({
      registry,
      providers,
      voiceSlice: {
        provider: providerId,
        model,
        voiceId: 'voice-1',
        locale: 'en-US',
      },
    });

    const mapped = provider.mapDeliveryTone(tone);

    expect(provider.capabilities.id).toBe(providerId);
    expect(provider.capabilities.kind).toBe('tts');
    expect(provider.capabilities.execution).toBe(execution);
    expect(mapped).toBeTruthy();
    expect(typeof provider.synthesizeStream).toBe(execution === 'client' ? 'undefined' : 'function');
    expect(Array.isArray(provider.usage?.())).toBe(true);
  });

  it('returns model-keyed ElevenLabs capabilities and inline-text tagging for v3', () => {
    const provider = createTTSProvider({
      registry,
      providers,
      voiceSlice: {
        provider: 'elevenlabs',
        model: 'eleven_v3',
        voiceId: 'voice-v3',
        locale: 'he-IL',
      },
    });

    expect(provider.capabilities.deliveryMode).toBe('inline-text-tags');
    expect(provider.capabilities.streaming).toBe(false);
    expect(provider.applyDeliveryToText?.('Shalom', {
      pace: 'slow',
      energy: 'low',
      emotion: 'sad',
    })).toContain('[sad]');
  });

  it('uses native params for ElevenLabs flash models', () => {
    const provider = createTTSProvider({
      registry,
      providers,
      voiceSlice: {
        provider: 'elevenlabs',
        model: 'eleven_flash_v2_5',
        voiceId: 'voice-flash',
        locale: 'en-US',
      },
    });

    expect(provider.capabilities.deliveryMode).toBe('native-params');
    expect(provider.capabilities.streaming).toBe(true);
  });

  it.each(['livekit', 'websocket'])('creates transport provider %s', async (providerId) => {
    const provider = createTransportProvider({
      registry,
      providers,
      voiceSlice: {
        provider: providerId,
        mode: 'pushToTalk',
        audioFormat: 'pcm16-16k',
      },
    });

    const session = await provider.mintSession({ voiceName: 'english-dev', userId: 'user-1' });

    expect(session.transport).toBe(providerId);
    expect(session.sessionId).toContain(providerId);
  });
});
