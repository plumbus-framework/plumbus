import { ErrorCode, PlumbusError } from '@plumbus/core';
import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import type { DeliveryTone } from '@plumbus/voice/provider-kit';
import { describe, expect, it, vi } from 'vitest';
import { resolveCredentialsFromEnv } from '../credentials.js';
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
      expect(url).toBe('https://api.minimax.test/v1/get_voice?GroupId=group-1');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body ?? '{}')).toEqual({ voice_type: 'all' });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            system_voice: [{ voice_id: 'sys-1', voice_name: 'System One' }],
            voice_cloning: [{ voice_id: 'clone-1', voice_name: 'Clone One' }],
            voice_generation: [{ voice_id: 'gen-1', voice_name: 'Generated One' }],
            base_resp: { status_code: 0, status_msg: 'success' },
          };
        },
      };
    });

    const voices = await MINIMAX_TTS_REGISTRATION.listVoices?.(
      {
        apiKey: 'minimax-key',
        baseUrl: 'https://api.minimax.test',
        options: { groupId: 'group-1' },
      },
      'speech-2.8-turbo',
      { fetcher },
    );

    expect(voices).toEqual([
      expect.objectContaining({ id: 'sys-1', displayName: 'System One' }),
      expect.objectContaining({ id: 'clone-1', displayName: 'Clone One' }),
      expect.objectContaining({ id: 'gen-1', displayName: 'Generated One' }),
    ]);
  });

  it('rejects wav format for streaming synthesis', async () => {
    const provider = createMiniMaxProvider({ options: { format: 'wav', streamingMode: 'http' } });
    await expect(
      provider.synthesizeStream('hi', provider.mapDeliveryTone({})).next(),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlumbusError &&
        error.code === ErrorCode.Validation &&
        /does not support wav/i.test(error.message),
    );
  });

  it('reads optional GroupId from env credentials helper', () => {
    expect(
      resolveCredentialsFromEnv({
        MINIMAX_API_KEY: 'key',
        MINIMAX_BASE_URL: 'https://api.minimax.test',
        MINIMAX_GROUP_ID: 'group-env',
      }),
    ).toEqual({
      apiKey: 'key',
      baseUrl: 'https://api.minimax.test',
      options: { groupId: 'group-env' },
    });
  });

  it('rejects get_voice catalog errors in base_resp', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          system_voice: [],
          base_resp: { status_code: 2013, status_msg: 'invalid params' },
        };
      },
    }));

    await expect(
      MINIMAX_TTS_REGISTRATION.listVoices?.(
        { apiKey: 'minimax-key', baseUrl: 'https://api.minimax.test' },
        'speech-2.8-turbo',
        { fetcher },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlumbusError &&
        error.code === ErrorCode.Validation &&
        error.message.includes('get_voice') &&
        error.metadata?.statusCode === 2013 &&
        error.metadata?.category === 'validation' &&
        error.metadata?.details === 'invalid params',
    );
  });

  it('rejects unsupported sampleRate / format before calling MiniMax', async () => {
    const badRate = createMiniMaxProvider({
      options: { sampleRate: 12_345, streamingMode: 'http' },
    });
    await expect(
      badRate.synthesizeStream('hi', badRate.mapDeliveryTone({})).next(),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlumbusError &&
        error.code === ErrorCode.Validation &&
        /sampleRate/i.test(error.message),
    );

    const badFormat = createMiniMaxProvider({
      options: { format: 'aac', streamingMode: 'http' },
    });
    await expect(
      badFormat.synthesizeStream('hi', badFormat.mapDeliveryTone({})).next(),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlumbusError &&
        error.code === ErrorCode.Validation &&
        /format/i.test(error.message),
    );
  });

  it('passes textNormalization, forceCbr, and voiceModify on the wire', async () => {
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
        options: {
          streamingMode: 'http',
          textNormalization: true,
          forceCbr: true,
          format: 'mp3',
          bitrate: 128_000,
          voiceModify: {
            pitch: 1,
            intensity: 2,
            timbre: 3,
            soundEffects: 'robotic',
          },
        },
      },
    });

    for await (const _chunk of provider.synthesizeStream('hi', provider.mapDeliveryTone({}))) {
      // drain
    }

    expect(bodies[0]).toMatchObject({
      voice_setting: expect.objectContaining({ text_normalization: true }),
      audio_setting: expect.objectContaining({
        format: 'mp3',
        bitrate: 128_000,
        force_cbr: true,
      }),
      voice_modify: {
        pitch: 1,
        intensity: 2,
        timbre: 3,
        sound_effects: 'robotic',
      },
    });
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
