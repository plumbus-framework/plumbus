import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it } from 'vitest';
import { SONIOX_TTS_REGISTRATION } from '../soniox-tts.js';

const live = process.env.VOICE_LIVE_TEST === '1';

describe.runIf(live)('Soniox TTS live smoke', () => {
  it('streams pcm audio for a short phrase when configured', async () => {
    if (!process.env.SONIOX_API_KEY) {
      return;
    }

    const registry = createProviderRegistry({
      tts: { soniox: SONIOX_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: { providers: { soniox: { apiKey: process.env.SONIOX_API_KEY } } },
      voiceSlice: {
        provider: 'soniox',
        model: 'tts-rt-v1',
        voiceId: 'Adrian',
        locale: 'en-US',
        options: { format: 'pcm_s16le', sampleRate: 16_000 },
      },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream(
      'Hello from Soniox live smoke.',
      provider.mapDeliveryTone({}),
    )) {
      if (chunk.byteLength > 0) {
        chunks.push(chunk);
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((chunk) => chunk.byteLength > 0)).toBe(true);
  }, 30_000);
});

describe.skipIf(live)('Soniox TTS live smoke', () => {
  it('is skipped unless VOICE_LIVE_TEST=1', () => {
    expect(process.env.VOICE_LIVE_TEST).not.toBe('1');
  });
});
