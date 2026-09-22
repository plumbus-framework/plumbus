import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSTTProvider } from '../../providers/factory.js';
import { createProviderRegistry } from '../../providers/registry.js';

const live = process.env.VOICE_LIVE_TEST === '1';

describe.runIf(live)('voice live integration', () => {
  it('openai whisper transcribe tiny fixture when available', async () => {
    if (!process.env.OPENAI_API_KEY) {
      return;
    }

    const fixturePath = resolveWhisperFixturePath();
    if (!fixturePath) {
      return;
    }

    const wav = await import('node:fs').then((fs) => fs.readFileSync(fixturePath));
    const registry = createProviderRegistry();
    const provider = createSTTProvider({
      registry,
      providers: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY } } },
      voiceSlice: { provider: 'openai-whisper', model: 'whisper-1' },
    });

    await provider.connect?.({ sessionId: 'live-whisper-smoke' });
    await provider.sendAudio?.({
      chunk: wav,
      contentType: 'audio/wav',
    });
    const finalized = await provider.finalize?.();
    expect(finalized?.text?.length).toBeGreaterThan(0);
    await provider.disconnect?.();
  }, 60_000);
});

describe.skipIf(live)('voice live integration', () => {
  it('is skipped unless VOICE_LIVE_TEST=1', () => {
    expect(process.env.VOICE_LIVE_TEST).not.toBe('1');
  });
});

function resolveWhisperFixturePath(): string | undefined {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiny.wav'),
    join(dirname(fileURLToPath(import.meta.url)), '../../../testing/fixtures/tiny.wav'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
