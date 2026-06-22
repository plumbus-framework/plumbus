import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { runVoiceTurn } from '../run-turn.js';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/mock-providers.js';

describe('runVoiceTurn stt.partial wiring', () => {
  it('forwards streaming STT partials through onEvent', async () => {
    const events: string[] = [];
    const states: string[] = [];
    const sttProvider = createMockSTTProvider({
      connect(args) {
        queueMicrotask(async () => {
          await args.onTranscript?.({ text: 'hel', final: false });
          await args.onTranscript?.({ text: 'hello', final: true });
        });
      },
      async finalize() {
        return { text: 'hello', final: true };
      },
      usage() {
        return [{ provider: 'mock-stt', kind: 'transcribe', quantity: 1, unit: 'seconds' }];
      },
    });

    const ctx = createTestContext();
    const voice = defineVoice({
      name: 'partialVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'reply' };
        },
      },
    });

    for await (const event of runVoiceTurn(ctx, {
      voiceDefinition: voice,
      sessionId: 'partial-session',
      sttProvider,
      ttsProvider: createMockTTSProvider({
        usage() {
          return [{ provider: 'mock-tts', kind: 'synthesize', quantity: 5, unit: 'characters' }];
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async (event) => {
        events.push(event.type);
        if (event.type === 'agent.state') {
          states.push(event.state);
        }
      },
    })) {
      void event;
    }

    expect(events).toContain('stt.partial');
    expect(events).toContain('stt.final');
    expect(states).toEqual(expect.arrayContaining(['Transcribing', 'Playing', 'Idle']));
  });
});
