import { describe, expect, it, vi } from 'vitest';
import { createProviderRegistry } from '../../registry.js';
import { createTTSProvider } from '../../factory.js';

describe('ElevenLabs TTS wire protocol', () => {
  it('uses inline text tags for v3 HTTP synthesis', async () => {
    const fetcher = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      expect(url).toContain('/text-to-speech/');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body ?? '{}') as { text?: string };
      expect(body.text).toContain('[sad]');

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
            yield Uint8Array.from([9, 9, 9]);
          },
        },
      };
    });

    const registry = createProviderRegistry();
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          elevenlabs: {
            apiKey: 'eleven-key',
            baseUrl: 'https://api.elevenlabs.test',
            options: { fetch: fetcher },
          },
        },
      },
      voiceSlice: {
        provider: 'elevenlabs',
        model: 'eleven_v3',
        voiceId: 'voice-v3',
        locale: 'he-IL',
      },
    });

    const text = provider.applyDeliveryToText?.('Shalom', {
      pace: 'slow',
      energy: 'low',
      emotion: 'sad',
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream(
      text ?? 'Shalom',
      provider.mapDeliveryTone({}),
    )) {
      chunks.push(chunk);
    }

    expect(fetcher).toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThan(0);
  });
});
