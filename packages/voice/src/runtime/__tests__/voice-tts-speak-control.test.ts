import { describe, expect, it } from 'vitest';
import { VoiceSessionController } from '../voice-session-controller.js';
import { defineVoice } from '../../define/defineVoice.js';
import { createTestContext } from '@plumbus/core/testing';
import {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockTransportProvider,
} from '../../testing/index.js';

describe('voice session tts.speak control', () => {
  it('speaks client-requested text without running the brain', async () => {
    const events: Array<{ type: string; text?: string; state?: string }> = [];
    const ttsTexts: string[] = [];
    const brainCalls: string[] = [];

    const voice = defineVoice({
      name: 'replayVoice',
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

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'session-replay',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider: createMockSTTProvider(),
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text) {
          ttsTexts.push(text);
          yield new Uint8Array([1, 2]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async (event) => {
        if (event.type === 'agent.state') {
          events.push({ type: event.type, state: event.state });
        } else if (event.type === 'assistant.delta' || event.type === 'tts.speak') {
          events.push({ type: event.type, text: event.text });
        } else {
          events.push({ type: event.type });
        }
      },
    });

    await controller.hello();
    await controller.handleControlMessage({
      type: 'tts.speak',
      text: '  שלום מחדש  ',
    });

    expect(brainCalls).toEqual([]);
    expect(ttsTexts).toEqual(['שלום מחדש']);
    expect(
      events.some((event) => event.type === 'assistant.delta' && event.text === 'שלום מחדש'),
    ).toBe(true);
    expect(events.some((event) => event.type === 'tts.speak' && event.text === 'שלום מחדש')).toBe(
      true,
    );
    expect(events.at(-1)).toEqual({ type: 'agent.state', state: 'Listening' });
  });

  it('passes resolved delivery tone (including targetGender) to TTS on replay', async () => {
    const ttsParams: unknown[] = [];

    const voice = defineVoice({
      name: 'replayVoiceTone',
      access: {},
      transport: { provider: 'livekit', mode: 'continuous' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'brain response' };
        },
      },
      toneProfiles: {
        warm_default: { pace: 'normal', warmth: 'high' },
      },
      resolveTone: async () => ({ profile: 'warm_default', targetGender: 'male' }),
    });

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'session-replay-tone',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider: createMockSTTProvider(),
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(_text, params) {
          ttsParams.push(params);
          yield new Uint8Array([1]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    await controller.handleControlMessage({ type: 'tts.speak', text: 'replay line' });
    expect(ttsParams[0]).toMatchObject({
      tone: { profile: 'warm_default', targetGender: 'male', pace: 'normal', warmth: 'high' },
    });
  });

  it('ignores empty tts.speak payloads', async () => {
    const ttsTexts: string[] = [];

    const voice = defineVoice({
      name: 'replayVoiceEmpty',
      access: {},
      transport: { provider: 'livekit', mode: 'continuous' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          return { text: 'brain response' };
        },
      },
    });

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'session-replay-empty',
      ctx: createTestContext(),
      sttProvider: createMockSTTProvider(),
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text) {
          ttsTexts.push(text);
          yield new Uint8Array([1]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    await controller.handleControlMessage({ type: 'tts.speak', text: '   ' });
    expect(ttsTexts).toEqual([]);
  });
});
