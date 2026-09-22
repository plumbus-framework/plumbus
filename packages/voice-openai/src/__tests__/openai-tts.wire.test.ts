import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { OPENAI_TTS_REGISTRATION } from '../openai-tts.js';

describe('OpenAI TTS via openai SDK', () => {
  it('calls audio.speech.create with custom baseURL and streams response body', async () => {
    const create = vi.fn(async (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: 'tts-1',
        voice: 'alloy',
        input: 'Hello there',
      });
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
    const clientFactory = vi.fn(({ apiKey, baseURL }: { apiKey: string; baseURL?: string }) => {
      expect(apiKey).toBe('openai-key');
      expect(baseURL).toBe('https://api.openai.test/v1');
      return {
        audio: {
          transcriptions: {
            create: async () => {
              throw new Error('unused');
            },
          },
          speech: { create },
        },
      };
    });

    const registry = createProviderRegistry({
      tts: { openai: OPENAI_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          openai: {
            apiKey: 'openai-key',
            baseUrl: 'https://api.openai.test/v1',
            options: { openaiClientFactory: clientFactory },
          },
        },
      },
      voiceSlice: {
        provider: 'openai',
        model: 'tts-1',
        voiceId: 'alloy',
      },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream(
      'Hello there',
      provider.mapDeliveryTone({}),
    )) {
      chunks.push(chunk);
    }

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
