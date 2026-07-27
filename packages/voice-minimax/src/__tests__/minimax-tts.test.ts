import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import type { DeliveryTone } from '@plumbus/voice/provider-kit';
import { describe, expect, it, vi } from 'vitest';
import { MINIMAX_TTS_REGISTRATION } from '../minimax-tts.js';

const tone: DeliveryTone = {
  pace: 'fast',
  warmth: 'high',
  energy: 'medium',
  emotion: 'calm',
};

function createMiniMaxProvider(voiceSlice: {
  model?: string;
  voiceId?: string;
  locale?: string;
  options?: Record<string, unknown>;
}) {
  const registry = createProviderRegistry({
    tts: { minimax: MINIMAX_TTS_REGISTRATION },
  });
  return createTTSProvider({
    registry,
    providers: {
      providers: {
        minimax: { apiKey: 'minimax-key', baseUrl: 'https://api.minimax.test' },
      },
    },
    voiceSlice: {
      provider: 'minimax',
      model: voiceSlice.model ?? 'speech-2.8-turbo',
      voiceId: voiceSlice.voiceId ?? 'voice-1',
      locale: voiceSlice.locale,
      options: voiceSlice.options,
    },
  });
}

describe('MiniMax TTS adapter', () => {
  it('maps full delivery tone axes and language boost for Hebrew locales', () => {
    const provider = createMiniMaxProvider({ locale: 'he-IL' });

    const mapped = provider.mapDeliveryTone(tone);
    expect(mapped).toMatchObject({
      model: 'speech-2.8-turbo',
      voiceId: 'voice-1',
      speed: expect.any(Number),
      pitch: 2,
      vol: expect.any(Number),
      emotion: 'calm',
      languageBoost: 'Hebrew',
    });
  });

  it('maps warmth to integer pitch semitones', () => {
    const provider = createMiniMaxProvider({});

    expect(provider.mapDeliveryTone({ warmth: 'low' })).toMatchObject({ pitch: -2 });
    expect(provider.mapDeliveryTone({ warmth: 'medium' })).toMatchObject({ pitch: 0 });
    expect(provider.mapDeliveryTone({ warmth: 'high' })).toMatchObject({ pitch: 2 });
    expect(provider.mapDeliveryTone({})).toMatchObject({ pitch: 0 });
  });

  it('clamps and rounds pitch in the wire voice_setting', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        async text() {
          return '';
        },
        async json() {
          return {};
        },
        body: {
          async *[Symbol.asyncIterator]() {},
        },
      };
    });

    const registry = createProviderRegistry({
      tts: { minimax: MINIMAX_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          minimax: {
            apiKey: 'minimax-key',
            baseUrl: 'https://api.minimax.test',
            options: { fetch: fetcher },
          },
        },
      },
      voiceSlice: {
        provider: 'minimax',
        model: 'speech-2.8-turbo',
        voiceId: 'voice-1',
        options: { streamingMode: 'http' },
      },
    });

    for await (const _chunk of provider.synthesizeStream('hi', {
      pitch: 7.6,
      voiceId: 'voice-1',
    })) {
      // drain
    }
    for await (const _chunk of provider.synthesizeStream('hi', {
      pitch: -99,
      voiceId: 'voice-1',
    })) {
      // drain
    }

    const pitches = bodies.map((body) => {
      const voiceSetting = body.voice_setting as { pitch?: number };
      return voiceSetting.pitch;
    });
    expect(pitches).toEqual([8, -12]);
  });

  it('drops whisper/fluent on speech-2.8 and keeps whisper on speech-2.6', () => {
    const speech28 = createMiniMaxProvider({ model: 'speech-2.8-turbo' });
    expect(speech28.mapDeliveryTone({ emotion: 'whisper' }).emotion).toBeUndefined();
    expect(speech28.mapDeliveryTone({ emotion: 'fluent' }).emotion).toBeUndefined();

    const speech26 = createMiniMaxProvider({ model: 'speech-2.6-hd' });
    expect(speech26.mapDeliveryTone({ emotion: 'whisper' }).emotion).toBe('whisper');
    expect(speech26.mapDeliveryTone({ emotion: 'fluent' }).emotion).toBe('fluent');
  });

  it('lists voices via POST /v1/get_voice and maps voice_name', async () => {
    const fetcher = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      expect(url).toBe('https://api.minimax.test/v1/get_voice');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body ?? '{}')).toEqual({ voice_type: 'all' });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            system_voice: [{ voice_id: 'sys-1', voice_name: 'System One' }],
            voice_cloning: [{ voice_id: 'clone-1', voice_name: 'Clone One' }],
          };
        },
      };
    });

    const voices = await MINIMAX_TTS_REGISTRATION.listVoices?.(
      { apiKey: 'minimax-key', baseUrl: 'https://api.minimax.test' },
      'speech-2.8-turbo',
      { fetcher },
    );

    expect(voices).toEqual([
      expect.objectContaining({ id: 'sys-1', displayName: 'System One' }),
      expect.objectContaining({ id: 'clone-1', displayName: 'Clone One' }),
    ]);
  });

  it('defaults audio_setting to mono PCM at transport sample rate', async () => {
    const fetcher = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as {
        audio_setting?: Record<string, unknown>;
      };
      expect(body.audio_setting).toEqual({
        sample_rate: 16_000,
        format: 'pcm',
        channel: 1,
      });
      expect(body.audio_setting).not.toHaveProperty('bitrate');
      return {
        ok: true,
        status: 200,
        async text() {
          return '';
        },
        async json() {
          return {};
        },
        body: {
          async *[Symbol.asyncIterator]() {},
        },
      };
    });

    const registry = createProviderRegistry({
      tts: { minimax: MINIMAX_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          minimax: {
            apiKey: 'minimax-key',
            baseUrl: 'https://api.minimax.test',
            options: { fetch: fetcher },
          },
        },
      },
      voiceSlice: {
        provider: 'minimax',
        model: 'speech-2.8-turbo',
        voiceId: 'voice-1',
        options: { streamingMode: 'http' },
      },
    });

    for await (const _chunk of provider.synthesizeStream('hi', provider.mapDeliveryTone({}))) {
      // drain
    }
    expect(fetcher).toHaveBeenCalled();
  });
});
