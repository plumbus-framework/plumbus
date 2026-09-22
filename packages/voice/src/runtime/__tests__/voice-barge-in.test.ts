import { describe, expect, it } from 'vitest';
import { VoiceSessionController } from '../voice-session-controller.js';
import { defineVoice } from '../../define/defineVoice.js';
import { createTestContext } from '@plumbus/core/testing';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

describe('voice session barge-in', () => {
  it('emits turn.interrupted and aborts in-flight synthesis', async () => {
    const events: Array<{ type: string }> = [];
    const ttsProvider = createMockTTSProvider({
      async *synthesizeStream() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield new Uint8Array([1]);
      },
      abortAll() {
        events.push({ type: 'tts.aborted' });
      },
    });

    const voice = defineVoice({
      name: 'continuousVoice',
      access: {},
      transport: { provider: 'livekit', mode: 'pushToTalk' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run(_ctx, args) {
          args.onAssistantDelta?.('Long response chunk');
          return { text: 'Long response chunk' };
        },
      },
    });

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'session-barge',
      ctx: createTestContext(),
      sttProvider: createMockSTTProvider(),
      ttsProvider,
      transportProvider: createMockTransportProvider(),
      onEvent: async (event) => {
        events.push({ type: event.type });
      },
    });

    await controller.handleControlMessage({ type: 'stt.final', text: 'hello there' });
    const turnPromise = controller.runTurn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await controller.bargeIn();
    await turnPromise;

    expect(events.some((event) => event.type === 'turn.interrupted')).toBe(true);
    expect(events.some((event) => event.type === 'tts.aborted')).toBe(true);
  });
});
