import { createTestContext, mockAI } from '@plumbus/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';
import { runVoiceTurn } from '../run-turn.js';

describe('runVoiceTurn budget pre-check', () => {
  it('calls checkProviderCostBudget before STT connect and fails when budget is exceeded', async () => {
    let connected = false;
    const checkProviderCostBudget = vi.fn(() => {
      throw new Error('AI budget exceeded: daily cost limit');
    });
    const ai = {
      ...mockAI(),
      checkProviderCostBudget,
      recordProviderCost: vi.fn(async () => {}),
    };
    const ctx = createTestContext({ ai });

    const voice = defineVoice({
      name: 'budgetVoice',
      access: {},
      transport: { provider: 'mock-transport' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'should not run' };
        },
      },
    });

    const sttProvider = createMockSTTProvider({
      async connect() {
        connected = true;
      },
    });

    const events = [];
    for await (const event of runVoiceTurn(ctx, {
      voiceDefinition: voice,
      sessionId: 'budget-session',
      transcript: 'hello',
      sttProvider,
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
    })) {
      events.push(event);
    }

    expect(checkProviderCostBudget).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedCostUsd: expect.any(Number) }),
    );
    expect(connected).toBe(false);
    expect(events.some((event) => event.type === 'turn.failed')).toBe(true);
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false);
  });

  it('proceeds with the turn when the budget pre-check passes', async () => {
    let connected = false;
    const checkProviderCostBudget = vi.fn();
    const ai = {
      ...mockAI(),
      checkProviderCostBudget,
      recordProviderCost: vi.fn(async () => {}),
    };
    const ctx = createTestContext({ ai });

    const voice = defineVoice({
      name: 'budgetOkVoice',
      access: {},
      transport: { provider: 'mock-transport' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'Hello there' };
        },
      },
    });

    const sttProvider = createMockSTTProvider({
      async connect() {
        connected = true;
      },
    });

    const events = [];
    for await (const event of runVoiceTurn(ctx, {
      voiceDefinition: voice,
      sessionId: 'budget-ok-session',
      transcript: 'hello',
      sttProvider,
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
    })) {
      events.push(event);
    }

    expect(checkProviderCostBudget).toHaveBeenCalled();
    // A caller-supplied transcript must NOT reconnect the (shared) STT provider —
    // reconnecting would clobber a session controller's onTranscript/onEndpoint.
    expect(connected).toBe(false);
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true);
  });
});
