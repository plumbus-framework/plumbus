import { describe, expect, it } from 'vitest';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { runVoiceTurn } from '../run-turn.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

describe('runVoiceTurn brain delta deduplication', () => {
  it('does not re-synthesize the full answer when the brain already streamed deltas', async () => {
    const synthesizedTexts: string[] = [];
    const ctx = createTestContext({
      auth: { userId: 'user-1', roles: ['user'], scopes: [], provider: 'test' },
      ai: mockAI(),
    });

    const voice = defineVoice({
      name: 'streamingBrainVoice',
      access: {},
      transport: { provider: 'mock-transport' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run(_ctx, args) {
          // Sentences above the chunker's micro-fragment merge threshold, so
          // each streams as its own chunk and the full-text dedup stays provable.
          args.onAssistantDelta?.('Alpha alpha alpha. ');
          args.onAssistantDelta?.('Beta beta beta.');
          return { text: 'Alpha alpha alpha. Beta beta beta.' };
        },
      },
    });

    const ttsProvider = createMockTTSProvider({
      async *synthesizeStream(text) {
        synthesizedTexts.push(text);
        yield new Uint8Array([1]);
      },
    });

    for await (const _event of runVoiceTurn(ctx, {
      voiceDefinition: voice,
      sessionId: 'dedupe-session',
      transcript: 'hi there',
      sttProvider: createMockSTTProvider(),
      ttsProvider,
      transportProvider: createMockTransportProvider(),
    })) {
      // consume stream
    }

    expect(
      synthesizedTexts.filter((text) => text === 'Alpha alpha alpha. Beta beta beta.'),
    ).toHaveLength(0);
    expect(synthesizedTexts.length).toBeGreaterThan(0);
  });
});
