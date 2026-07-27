import { createProviderRegistry, createSTTProvider } from '@plumbus/voice';
import { describe, expect, it } from 'vitest';
import { SONIOX_STT_REGISTRATION } from '../soniox-stt.js';

const live = process.env.VOICE_LIVE_TEST === '1';

describe.runIf(live)('Soniox STT live smoke', () => {
  it('connects and finalizes a short session when configured', async () => {
    if (!process.env.SONIOX_API_KEY) {
      return;
    }

    const registry = createProviderRegistry({
      stt: { soniox: SONIOX_STT_REGISTRATION },
    });
    const provider = createSTTProvider({
      registry,
      providers: { providers: { soniox: { apiKey: process.env.SONIOX_API_KEY } } },
      voiceSlice: { provider: 'soniox', model: 'stt-rt-preview', languages: ['en'] },
    });

    await provider.connect?.({ sessionId: 'live-soniox-smoke' });
    await provider.sendAudio?.({
      chunk: Uint8Array.from([0, 0, 1, 0]),
      contentType: 'pcm16;rate=16000;channels=1',
    });
    const finalized = await provider.finalize?.();
    expect(finalized?.text).toBeTypeOf('string');
    await provider.disconnect?.();
  }, 30_000);
});

describe.skipIf(live)('Soniox STT live smoke', () => {
  it('is skipped unless VOICE_LIVE_TEST=1', () => {
    expect(process.env.VOICE_LIVE_TEST).not.toBe('1');
  });
});
