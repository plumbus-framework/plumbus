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
      brain: {
        async run() {
          return { text: 'unused' };
        },
      },
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

  it('preserves inter-word spaces from streaming deltas (does not mash words)', async () => {
    const ttsTexts: string[] = [];
    const voice = defineVoice({
      name: 'spaceVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'unused' };
        },
      },
    });

    const ttsProvider = createMockTTSProvider({
      async *synthesizeStream(text: string) {
        ttsTexts.push(text);
        yield Uint8Array.from([1]);
      },
    });

    await runStreamingTurnPipeline({
      ctx: createTestContext(),
      voice,
      sessionId: 'session-spaces',
      transcriptText: 'hi',
      ttsProvider,
      transportProvider: createMockTransportProvider(),
      mappedTone: { tone: undefined, providerParams: {} },
      // Mimic OpenAI streaming: tokens carry leading spaces as word boundaries.
      runBrain: async (onDelta) => {
        for (const token of ['כן', ',', ' שומעים', ' אותך', '.']) {
          await onDelta(token);
        }
        return 'כן, שומעים אותך.';
      },
    });

    const spoken = ttsTexts.join(' ');
    expect(spoken).toContain('שומעים אותך');
    expect(spoken).not.toContain('שומעיםאותך');
  });

  it('strips sentinel markers at the sentence level', async () => {
    const ttsTexts: string[] = [];
    const voice = defineVoice({
      name: 'markerVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'unused' };
        },
      },
    });

    const ttsProvider = createMockTTSProvider({
      async *synthesizeStream(text: string) {
        ttsTexts.push(text);
        yield Uint8Array.from([1]);
      },
    });

    await runStreamingTurnPipeline({
      ctx: createTestContext(),
      voice,
      sessionId: 'session-markers',
      transcriptText: 'hi',
      ttsProvider,
      transportProvider: createMockTransportProvider(),
      mappedTone: { tone: undefined, providerParams: {} },
      runBrain: async (onDelta) => {
        await onDelta('Goodbye now. [END_SESSION]');
        return 'Goodbye now. [END_SESSION]';
      },
    });

    const spoken = ttsTexts.join(' ');
    expect(spoken).toContain('Goodbye now.');
    expect(spoken).not.toContain('[END_SESSION]');
  });
});
