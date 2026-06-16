import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { runStreamingTurnPipeline } from '../streaming-turn-pipeline.js';
import { createMockTTSProvider, createMockTransportProvider } from '../../testing/index.js';

describe('streaming turn pipeline', () => {
  it('streams assistant deltas into TTS while the brain is still running', async () => {
    const events: string[] = [];
    const voice = defineVoice({
      name: 'streamVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: { async run() { return { text: 'unused' }; } },
    });

    const ttsProvider = createMockTTSProvider({
      async *synthesizeStream(text: string) {
        events.push(`tts:${text}`);
        yield Uint8Array.from([1]);
      },
    });
    const transportProvider = createMockTransportProvider();
    const ctx = createTestContext();

    const result = await runStreamingTurnPipeline({
      ctx,
      voice,
      sessionId: 'session-1',
      transcriptText: 'hello',
      ttsProvider,
      transportProvider,
      mappedTone: { tone: undefined, providerParams: {} },
      runBrain: async (onDelta) => {
        await onDelta('First sentence. ');
        await onDelta('Second sentence.');
        return 'First sentence. Second sentence.';
      },
    });

    expect(result.responseText).toContain('First sentence');
    expect(events.some((entry) => entry.startsWith('tts:'))).toBe(true);
  });
});
