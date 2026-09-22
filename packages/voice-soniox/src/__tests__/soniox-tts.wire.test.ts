import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { SONIOX_TTS_REGISTRATION } from '../soniox-tts.js';

describe('Soniox TTS via @soniox/node SDK', () => {
  it('streams pcm_s16le audio through client.tts.generateStream', async () => {
    const generateStream = vi.fn(async function* (options: Record<string, unknown>) {
      expect(options).toMatchObject({
        text: 'Shalom from Soniox',
        voice: 'Adrian',
        model: 'tts-rt-v1',
        language: 'he',
        audio_format: 'pcm_s16le',
        sample_rate: 16_000,
      });
      yield Uint8Array.from([1, 2, 3, 4]);
    });
    const clientFactory = vi.fn((apiKey: string) => {
      expect(apiKey).toBe('soniox-key');
      return { tts: { generateStream } };
    });

    const registry = createProviderRegistry({
      tts: { soniox: SONIOX_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          soniox: {
            apiKey: 'soniox-key',
            options: { sonioxTtsClientFactory: clientFactory },
          },
        },
      },
      voiceSlice: {
        provider: 'soniox',
        model: 'tts-rt-v1',
        voiceId: 'Adrian',
        locale: 'he-IL',
      },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream(
      'Shalom from Soniox',
      provider.mapDeliveryTone({}),
    )) {
      chunks.push(chunk);
    }

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(generateStream).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(provider.usage()).toEqual([
      expect.objectContaining({
        provider: 'soniox',
        kind: 'synthesize',
        quantity: 'Shalom from Soniox'.length,
        unit: 'characters',
        model: 'soniox-tts',
      }),
    ]);
  });

  it('lists voices from client.tts.listModels when available', async () => {
    const listModels = vi.fn(async () => [
      {
        id: 'tts-rt-v1',
        voices: [
          { id: 'Maya', description: 'Steady clear voice', gender: 'female' },
          { id: 'Adrian', description: 'Deep focused voice', gender: 'male' },
        ],
      },
    ]);
    const clientFactory = vi.fn(() => ({
      tts: {
        generateStream: async function* () {},
        listModels,
      },
    }));

    const voices = await SONIOX_TTS_REGISTRATION.listVoices?.(
      {
        apiKey: 'soniox-key',
        options: { sonioxTtsClientFactory: clientFactory },
      },
      'tts-rt-v1',
      { fetcher: vi.fn() },
    );

    expect(listModels).toHaveBeenCalled();
    expect(voices).toEqual([
      expect.objectContaining({ id: 'Maya' }),
      expect.objectContaining({ id: 'Adrian' }),
    ]);
  });

  it('forwards AbortSignal to client.tts.generateStream', async () => {
    const controller = new AbortController();
    const generateStream = vi.fn(async function* (options: Record<string, unknown>) {
      expect(options.signal).toBe(controller.signal);
      yield Uint8Array.from([9]);
    });
    const clientFactory = vi.fn(() => ({ tts: { generateStream } }));

    const registry = createProviderRegistry({
      tts: { soniox: SONIOX_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          soniox: {
            apiKey: 'soniox-key',
            options: { sonioxTtsClientFactory: clientFactory },
          },
        },
      },
      voiceSlice: {
        provider: 'soniox',
        model: 'tts-rt-v1',
        voiceId: 'Adrian',
        locale: 'en-US',
      },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream(
      'Abort me',
      provider.mapDeliveryTone({}),
      controller.signal,
    )) {
      chunks.push(chunk);
    }

    expect(generateStream).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([9]));
  });
});
