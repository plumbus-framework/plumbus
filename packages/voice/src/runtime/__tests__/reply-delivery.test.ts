import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { runVoiceTurn } from '../run-turn.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

describe('complete reply delivery', () => {
  it('uses one brain result for text and tone, and synthesizes the intact reply once', async () => {
    const text = 'זה נשמע משמעותי. מה הרגשת באותו רגע?';
    const run = vi.fn(async (_ctx, args) => {
      expect(args.transcriptConfidence).toBe(0.4);
      args.onAssistantDelta?.('זה נשמע משמעותי. ');
      args.onAssistantDelta?.('מה הרגשת באותו רגע?');
      return { text, metadata: { tone: 'gentle' } };
    });
    const tone = vi.fn((_ctx, args) => {
      expect(args.assistantText).toBe(text);
      expect(args.brainResult.metadata.tone).toBe('gentle');
      return 'gentle';
    });
    const voice = defineVoice({
      name: 'reply',
      access: {},
      transport: { provider: 'mock' },
      stt: { provider: 'mock' },
      tts: { provider: 'mock', responseMode: 'reply' },
      brain: { run },
      resolveTone: tone,
      toneProfiles: { gentle: { pace: 'slow' } },
      preprocessForTts: (value) => `אמממ... ${value}`,
    });
    const spoken: string[] = [],
      visible: string[] = [];
    const events = [];
    for await (const e of runVoiceTurn(createTestContext(), {
      voiceDefinition: voice,
      sessionId: 'test',
      transcript: 'memory',
      transcriptConfidence: 0.4,
      sttProvider: createMockSTTProvider(),
      transportProvider: createMockTransportProvider(),
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(value) {
          spoken.push(value);
          yield new Uint8Array();
        },
      }),
      async onAssistantDelta(value) {
        await Promise.resolve();
        visible.push(value);
      },
    }))
      events.push(e);
    expect(run).toHaveBeenCalledTimes(1);
    expect(tone).toHaveBeenCalledTimes(1);
    expect(spoken).toEqual([`אמממ... ${text}`]);
    expect(visible.join('')).toBe(text);
    expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({ responseText: text });
  });

  it('does not synthesize a reply after interruption', async () => {
    const abort = new AbortController();
    const tts = vi.fn();
    const voice = defineVoice({
      name: 'cancel',
      access: {},
      transport: { provider: 'mock' },
      stt: { provider: 'mock' },
      tts: { provider: 'mock', responseMode: 'reply' },
      brain: {
        run() {
          abort.abort();
          return { text: 'must not be spoken' };
        },
      },
    });
    for await (const _event of runVoiceTurn(createTestContext(), {
      voiceDefinition: voice,
      sessionId: 'test',
      transcript: 'hello',
      abortSignal: abort.signal,
      sttProvider: createMockSTTProvider(),
      transportProvider: createMockTransportProvider(),
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream() {
          tts();
          yield new Uint8Array();
        },
      }),
    })) {
      /* drain */
    }
    expect(tts).not.toHaveBeenCalled();
  });
});
