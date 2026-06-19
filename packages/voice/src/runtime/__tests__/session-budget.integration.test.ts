import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { createVoiceSessionBudget } from '../../cost/session-budget.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/mock-providers.js';
import { VoiceSessionController } from '../voice-session-controller.js';
import type { VoiceEvent } from '../../types/event.js';

describe('voice session budget integration', () => {
  it('emits session_budget_exceeded when audio input cap is exceeded', async () => {
    const events: VoiceEvent[] = [];
    const voice = defineVoice({
      name: 'budgetVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'budget-session',
      ctx: createTestContext(),
      sttProvider: createMockSTTProvider(),
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
      budget: createVoiceSessionBudget({ maxAudioInputSeconds: 0.01 }),
      onEvent: async (event) => {
        events.push(event);
      },
    });

    await controller.handleAudioChunk(new Uint8Array(32_000), 'pcm16;rate=16000;channels=1');

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          code: 'voice.session_budget_exceeded',
        }),
      ]),
    );
  });

  it('emits session_budget_exceeded when STT character cap is exceeded on final transcript', async () => {
    const events: VoiceEvent[] = [];
    const voice = defineVoice({
      name: 'budgetCharsVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
    });

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'budget-chars-session',
      ctx: createTestContext(),
      sttProvider: createMockSTTProvider(),
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
      budget: createVoiceSessionBudget({ maxSttCharacters: 3 }),
      onEvent: async (event) => {
        events.push(event);
      },
    });

    await controller.handleControlMessage({
      type: 'stt.final',
      text: 'this transcript is too long',
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          code: 'voice.session_budget_exceeded',
        }),
      ]),
    );
  });
});
