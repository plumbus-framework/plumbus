import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import type { ExecutionContext } from '@plumbus/core';
import type { VoiceBrainRunArgs } from '../../types/voice.js';
import { defineVoice } from '../../define/defineVoice.js';
import { runVoiceTurn } from '../run-turn.js';
import { VoiceSessionController } from '../voice-session-controller.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';
import type { STTProviderConnectArgs } from '../../providers/base/stt-provider.js';
import type { VoiceEvent } from '../../types/event.js';

function voiceWithLimit(maxChars?: number) {
  const brain = vi.fn(async (_ctx: ExecutionContext, _args: VoiceBrainRunArgs) => ({
    text: 'Thank you for sharing.',
  }));
  return {
    brain,
    voice: defineVoice({
      name: 'longInterview',
      access: {},
      transport: { provider: 'mock', mode: 'continuous' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      transcript: maxChars === undefined ? undefined : { maxChars },
      brain: { run: brain },
    }),
  };
}

describe('configured voice transcript limits', () => {
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid maximum %s at definition time', (maxChars) => {
    expect(() => voiceWithLimit(maxChars)).toThrow(/transcript.maxChars/);
  });

  it.each([
    [undefined, 4000, true],
    [undefined, 4001, false],
    [30000, 4001, true],
    [30000, 30000, true],
    [30000, 30001, false],
  ] as const)('enforces max=%s with %i characters (accepted=%s)', async (maxChars, length, accepted) => {
    const { voice, brain } = voiceWithLimit(maxChars);
    const text = 'א'.repeat(length);
    const events: VoiceEvent[] = [];
    for await (const event of runVoiceTurn(createTestContext(), {
      voiceDefinition: voice,
      sessionId: 'long-turn',
      transcript: text,
      sttProvider: createMockSTTProvider(),
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
    }))
      events.push(event);
    expect(brain).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted) expect(brain.mock.calls[0]?.[1]).toMatchObject({ transcript: text });
    expect(events.some((e) => e.type === 'turn.completed')).toBe(accepted);
    if (!accepted)
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'turn.failed', code: 'voice.transcript_invalid' }),
      );
    if (voice.transcript) expect(Object.isFrozen(voice.transcript)).toBe(true);
  });

  it('also uses the configured limit when the STT provider finalizes the transcript', async () => {
    const { voice, brain } = voiceWithLimit(30000);
    const text = 'מילה '.repeat(1200).trim();
    for await (const _event of runVoiceTurn(createTestContext(), {
      voiceDefinition: voice,
      sessionId: 'finalized-turn',
      sttProvider: createMockSTTProvider({ finalize: () => ({ text, final: true }) }),
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
    })) {
      /* Drain the normal governed turn. */
    }
    expect(brain.mock.calls[0]?.[1]).toMatchObject({ transcript: text });
  });

  it('passes a long cumulative Hebrew answer through the continuous session without truncation', async () => {
    const { voice, brain } = voiceWithLimit(30000);
    const text = 'זהו זיכרון ארוך מהילדות שלי. '.repeat(500).trim();
    let source: STTProviderConnectArgs | undefined;
    const baseStt = createMockSTTProvider({
      connect(args) {
        source = args;
      },
    });
    const stt = { ...baseStt, capabilities: { ...baseStt.capabilities, endpointDetection: true } };
    const controller = new VoiceSessionController({
      voice,
      sessionId: 'continuous-long',
      ctx: createTestContext(),
      sttProvider: stt,
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
      onEvent() {},
    });
    try {
      await controller.hello();
      await source?.onTranscript?.({ text: text.slice(0, 6000), final: false, confidence: 0.99 });
      await source?.onTranscript?.({ text, final: true, confidence: 0.99 });
      await source?.onEndpoint?.();
      expect(brain).toHaveBeenCalledTimes(1);
      expect(brain.mock.calls[0]?.[1]).toMatchObject({ transcript: text });
    } finally {
      await controller.dispose();
    }
  });
});
