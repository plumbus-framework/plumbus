import { describe, expect, it, vi } from 'vitest';
import { createProviderRegistry } from '../../registry.js';
import { createTTSProvider } from '../../factory.js';

describe('OpenAI TTS wire protocol', () => {
  it('posts speech synthesis requests with auth and streaming accept header', async () => {
    const fetcher = vi.fn(
      async (
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        expect(url).toBe('https://api.openai.test/v1/audio/speech');
        expect(init?.method).toBe('POST');
        expect(init?.headers?.Authorization).toBe('Bearer openai-key');
        expect(init?.headers?.Accept).toBe('application/octet-stream');
        expect(JSON.parse(init?.body ?? '{}')).toMatchObject({
          model: 'tts-1',
          voice: 'alloy',
          input: 'Hello there',
        });

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
            async *[Symbol.asyncIterator]() {
              yield Uint8Array.from([1, 2, 3]);
            },
          },
        };
      },
    );

    const registry = createProviderRegistry();
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          openai: {
            apiKey: 'openai-key',
            baseUrl: 'https://api.openai.test/v1',
            options: { fetch: fetcher },
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

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(1);
  });
});
