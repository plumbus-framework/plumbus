import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it } from 'vitest';
import { DEEPDUB_TTS_REGISTRATION } from '../deepdub-tts.js';

const live = process.env.VOICE_LIVE_TEST === '1';

describe.runIf(live)('Deepdub TTS live smoke', () => {
  it('synthesizes a short utterance when configured', async () => {
    const apiKey = process.env.DEEPDUB_API_KEY;
    const voiceId = process.env.DEEPDUB_VOICE_ID;
    if (!apiKey || !voiceId) {
      return;
    }

    const registry = createProviderRegistry({
      tts: { deepdub: DEEPDUB_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: { providers: { deepdub: { apiKey } } },
      voiceSlice: { provider: 'deepdub', model: 'phantom-x', voiceId, locale: 'he-IL' },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream?.('shalom', provider.mapDeliveryTone({})) ??
      []) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(live)('Deepdub TTS live smoke', () => {
  it('is skipped unless VOICE_LIVE_TEST=1', () => {
    expect(process.env.VOICE_LIVE_TEST).not.toBe('1');
  });
});
