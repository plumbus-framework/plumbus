import { describe, expect, it } from 'vitest';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { runVoiceTurn } from '../run-turn.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

describe('runVoiceTurn smoke', () => {
  it('completes one mocked turn and records transcribe + synthesize usage', async () => {
    const recordedCosts: Array<{ operation: string; provider: string }> = [];
    const ai = {
      ...mockAI(),
      async recordProviderCost(entry: { operation: string; provider: string }) {
        recordedCosts.push({ operation: entry.operation, provider: entry.provider });
      },
    };
    const ctx = createTestContext({
      auth: { userId: 'user-1', roles: ['user'], scopes: [], provider: 'test' },
      ai,
    });

    const voice = defineVoice({
      name: 'mockVoice',
      access: {},
      transport: { provider: 'mock-transport' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run(_ctx, args: any) {
          args.onAssistantDelta?.('Hello world. ');
          args.onAssistantDelta?.('More help is on the way');
          return { text: 'Hello world. More help is on the way' };
        },
      },
      resolveTone: async () => 'calm',
      toneProfiles: {
        calm: { pace: 'slow', warmth: 'high' },
      },
    });

    const sttProvider = createMockSTTProvider({
      usage() {
        return [{ provider: 'mock-stt', kind: 'transcribe', quantity: 1, unit: 'seconds' }];
      },
    });
    const ttsProvider = createMockTTSProvider({
      usage() {
        return [{ provider: 'mock-tts', kind: 'synthesize', quantity: 31, unit: 'characters' }];
      },
    });
    const transportProvider = createMockTransportProvider();

    const events = [];
    for await (const event of runVoiceTurn(ctx, {
      voiceDefinition: voice,
      sessionId: '00000000-0000-4000-8000-000000000001',
      transcript: 'hi there',
      sttProvider,
      ttsProvider,
      transportProvider,
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'turn.completed')).toBe(true);
    expect(events.some((event) => event.type === 'agent.tone')).toBe(true);
    expect(recordedCosts).toEqual([
      { operation: 'transcribe', provider: 'mock-stt' },
      { operation: 'synthesize', provider: 'mock-tts' },
    ]);
  });
});
