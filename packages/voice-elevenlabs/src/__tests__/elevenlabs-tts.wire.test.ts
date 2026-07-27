import { createRequire } from 'node:module';
import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { ELEVENLABS_TTS_REGISTRATION } from '../elevenlabs-tts.js';

interface CapturedStream {
  voiceId: string;
  request: {
    text: string;
    modelId?: string;
    languageCode?: string;
    outputFormat?: string;
    voiceSettings?: {
      speed?: number;
      stability?: number;
      similarityBoost?: number;
    };
  };
}

function makeFakeElevenLabsFactory(
  captured: {
    streams: CapturedStream[];
    searches: number;
    constructed: number;
  },
  chunk = new Uint8Array([9, 9, 9]),
) {
  return () => {
    captured.constructed += 1;
    return {
      textToSpeech: {
        async stream(voiceId: string, request: CapturedStream['request']) {
          captured.streams.push({ voiceId, request });
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
              controller.close();
            },
          });
        },
      },
      voices: {
        async search() {
          captured.searches += 1;
          return {
            voices: [
              {
                voiceId: 'voice-a',
                name: 'Voice A',
                supported_models: ['eleven_v3'],
              },
              {
                voiceId: 'voice-b',
                name: 'Voice B',
                supported_models: ['eleven_flash_v2_5'],
              },
            ],
          };
        },
      },
    };
  };
}

function createElevenProvider(
  elevenLabsClientFactory: unknown,
  voiceSlice: {
    model: string;
    voiceId: string;
    locale: string;
  },
) {
  const registry = createProviderRegistry({
    tts: { elevenlabs: ELEVENLABS_TTS_REGISTRATION },
  });
  return createTTSProvider({
    registry,
    providers: {
      providers: {
        elevenlabs: {
          apiKey: 'eleven-key',
          baseUrl: 'https://api.elevenlabs.test',
          options: { elevenLabsClientFactory },
        },
      },
    },
    voiceSlice: {
      provider: 'elevenlabs',
      ...voiceSlice,
    },
  });
}

describe('ElevenLabs TTS via @elevenlabs/elevenlabs-js SDK', () => {
  it('streams v3 through client.textToSpeech.stream with delivery tags in text', async () => {
    const captured = { streams: [] as CapturedStream[], searches: 0, constructed: 0 };
    const provider = createElevenProvider(makeFakeElevenLabsFactory(captured), {
      model: 'eleven_v3',
      voiceId: 'voice-v3',
      locale: 'he-IL',
    });

    const text = provider.applyDeliveryToText?.('Shalom', {
      pace: 'slow',
      energy: 'low',
      emotion: 'sad',
    });
    expect(text).toContain('[sad]');

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream(
      text ?? 'Shalom',
      provider.mapDeliveryTone({ emotion: 'sad', energy: 'low' }),
    )) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(captured.streams).toHaveLength(1);
    expect(captured.streams[0]?.voiceId).toBe('voice-v3');
    expect(captured.streams[0]?.request.text).toContain('[sad]');
    expect(captured.streams[0]?.request.modelId).toBe('eleven_v3');
    expect(captured.streams[0]?.request.languageCode).toBe('heb');
    expect(captured.streams[0]?.request.voiceSettings).toBeUndefined();
  });

  it('streams flash with voiceSettings from mapDeliveryTone', async () => {
    const captured = { streams: [] as CapturedStream[], searches: 0, constructed: 0 };
    const provider = createElevenProvider(makeFakeElevenLabsFactory(captured), {
      model: 'eleven_flash_v2_5',
      voiceId: 'voice-flash',
      locale: 'en-US',
    });

    const tone = provider.mapDeliveryTone({
      pace: 'fast',
      warmth: 'high',
      energy: 'high',
    });
    for await (const _chunk of provider.synthesizeStream('Hello', tone)) {
      // consume
    }

    expect(captured.streams).toHaveLength(1);
    expect(captured.streams[0]?.request).toMatchObject({
      text: 'Hello',
      modelId: 'eleven_flash_v2_5',
      languageCode: 'eng',
      voiceSettings: {
        speed: 1.15,
        stability: 0.75,
        similarityBoost: 0.85,
      },
    });
  });

  it('listVoices calls voices.search and filters by model', async () => {
    const captured = { streams: [] as CapturedStream[], searches: 0, constructed: 0 };
    const factory = makeFakeElevenLabsFactory(captured);
    const voices = await ELEVENLABS_TTS_REGISTRATION.listVoices?.(
      {
        apiKey: 'eleven-key',
        options: { elevenLabsClientFactory: factory },
      },
      'eleven_v3',
      { fetcher: vi.fn() },
    );

    expect(captured.searches).toBe(1);
    expect(voices?.map((voice) => voice.id)).toEqual(['voice-a']);
  });

  it('rejects Hebrew + flash before calling the SDK', async () => {
    const captured = { streams: [] as CapturedStream[], searches: 0, constructed: 0 };
    const provider = createElevenProvider(makeFakeElevenLabsFactory(captured), {
      model: 'eleven_flash_v2_5',
      voiceId: 'voice-flash',
      locale: 'he-IL',
    });

    await expect(
      (async () => {
        for await (const _chunk of provider.synthesizeStream('שלום', undefined)) {
          // should not yield
        }
      })(),
    ).rejects.toThrow(/flash does not support Hebrew/i);

    expect(captured.constructed).toBe(0);
    expect(captured.streams).toHaveLength(0);
  });

  it('does not load the SDK when constructing the provider', () => {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve('@elevenlabs/elevenlabs-js');
    delete require.cache[sdkEntry];

    const registry = createProviderRegistry({
      tts: { elevenlabs: ELEVENLABS_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          elevenlabs: { apiKey: 'eleven-key' },
        },
      },
      voiceSlice: {
        provider: 'elevenlabs',
        model: 'eleven_v3',
        voiceId: 'voice-v3',
        locale: 'he-IL',
      },
    });

    expect(provider.capabilities.id).toBe('elevenlabs');
    expect(provider.capabilities.streaming).toBe(true);
    expect(require.cache[sdkEntry]).toBeUndefined();
  });
});
