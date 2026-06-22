import { describe, expect, it } from 'vitest';
import { VoiceSessionController } from '../voice-session-controller.js';
import { defineVoice } from '../../define/defineVoice.js';
import { createTestContext } from '@plumbus/core/testing';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

function encodePcm16(samples: number[]): Uint8Array {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, Math.round((samples[index] ?? 0) * 32_767), true);
  }
  return output;
}

describe('voice session hearing repair', () => {
  it('does not speak a repair prompt on empty endpoint without speech energy', async () => {
    const brainCalls: string[] = [];
    const ttsTexts: string[] = [];

    const voice = defineVoice({
      name: 'repairVoice',
      access: {},
      transport: { provider: 'livekit', mode: 'continuous' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run(_ctx, args) {
          brainCalls.push(args.transcript ?? '');
          return { text: 'brain response' };
        },
      },
    });

    const sttProvider = createMockSTTProvider({
      connect(args) {
        void args.onEndpoint?.();
      },
    });

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'repair-empty',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider,
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text) {
          ttsTexts.push(text);
          yield new Uint8Array([1, 2]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    await controller.hello();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(brainCalls).toEqual([]);
    expect(ttsTexts).toEqual([]);
  });

  it('speaks a repair prompt on empty endpoint after speech energy', async () => {
    const ttsTexts: string[] = [];

    const voice = defineVoice({
      name: 'repairVoiceEnergy',
      access: {},
      transport: { provider: 'livekit', mode: 'continuous', audioFormat: 'pcm16-16k' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'brain response' };
        },
      },
    });

    let endpointHandler: (() => void) | undefined;
    const sttProvider = createMockSTTProvider({
      connect(args) {
        endpointHandler = () => {
          void args.onEndpoint?.();
        };
      },
    });

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'repair-energy',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider,
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text) {
          ttsTexts.push(text);
          yield new Uint8Array([1, 2]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    await controller.hello();
    await controller.handleAudioChunk(encodePcm16([0.5, -0.5, 0.4, -0.4]));
    endpointHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ttsTexts).toEqual(['לא הצלחתי לשמוע את זה ברור. אפשר לחזור שוב?']);
  });

  it('asks to spell uncertain names instead of running a brain turn', async () => {
    const brainCalls: string[] = [];
    const ttsTexts: string[] = [];

    const voice = defineVoice({
      name: 'repairNameVoice',
      access: {},
      transport: { provider: 'livekit', mode: 'continuous' },
      stt: { provider: 'mock-stt', options: { lowConfidenceThreshold: 0.55 } },
      tts: { provider: 'mock-tts' },
      brain: {
        async run(_ctx, args) {
          brainCalls.push(args.transcript ?? '');
          return { text: 'brain response' };
        },
      },
    });

    const sttProvider = createMockSTTProvider({
      connect(args) {
        queueMicrotask(async () => {
          await args.onTranscript?.({
            text: 'John דוד',
            final: true,
            confidence: 0.4,
            language: 'he',
          });
          await args.onEndpoint?.();
        });
      },
    });

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'repair-name',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider,
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text) {
          ttsTexts.push(text);
          yield new Uint8Array([1]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    await controller.hello();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(brainCalls).toEqual([]);
    expect(ttsTexts).toEqual(['אפשר לאיית את השם?']);
  });
});
