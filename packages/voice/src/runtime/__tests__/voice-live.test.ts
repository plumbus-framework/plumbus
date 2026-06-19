import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../../providers/registry.js';
import {
  createSTTProvider,
  createTransportProvider,
  createTTSProvider,
} from '../../providers/factory.js';

const live = process.env.VOICE_LIVE_TEST === '1';
const fixtures: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()?.close();
  }
});

describe.runIf(live)('voice live integration', () => {
  it('soniox STT short connect/finalize smoke', async () => {
    if (!process.env.SONIOX_API_KEY) {
      return;
    }

    const registry = createProviderRegistry();
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

  it('livekit mintSession smoke', async () => {
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return;
    }

    const registry = createProviderRegistry();
    const transport = createTransportProvider({
      registry,
      providers: {
        providers: {
          livekit: {
            url: LIVEKIT_URL,
            apiKey: LIVEKIT_API_KEY,
            apiSecret: LIVEKIT_API_SECRET,
          },
        },
      },
      voiceSlice: { provider: 'livekit', mode: 'pushToTalk' },
    });

    const session = await transport.mintSession?.({ voiceName: 'liveSmoke', userId: 'tester' });
    expect(session?.sessionId).toMatch(/^livekit:/);
    expect(session?.metadata).toBeTruthy();
  }, 30_000);

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

  it('deepdub TTS short synthesize smoke when configured', async () => {
    const apiKey = process.env.DEEPDUB_API_KEY;
    const voiceId = process.env.DEEPDUB_VOICE_ID;
    if (!apiKey || !voiceId) {
      return;
    }

    const registry = createProviderRegistry();
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
