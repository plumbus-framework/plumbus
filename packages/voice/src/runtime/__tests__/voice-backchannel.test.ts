import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSessionController } from '../voice-session-controller.js';
import { defineVoice } from '../../define/defineVoice.js';
import { createTestContext, mockAI } from '@plumbus/core/testing';
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

const speechChunk = encodePcm16([0.5, -0.5, 0.4, -0.4]);

function createBackchannelVoice(overrides: Record<string, unknown> = {}) {
  return defineVoice({
    name: 'backchannelVoice',
    access: {},
    transport: { provider: 'livekit', mode: 'continuous', audioFormat: 'pcm16-16k' },
    stt: {
      provider: 'mock-stt',
      options: {
        backchannelEnabled: true,
        backchannelPauseMs: 30,
        backchannelMinTranscriptChars: 10,
        backchannelCooldownMs: 0,
        backchannelPhrases: ['מהמ', 'כן'],
        endpointGraceMs: 50,
        ...overrides,
      },
    },
    tts: { provider: 'deepdub', model: 'dd-etts-3.2', voiceId: 'voice-1' },
    brain: {
      async run(_ctx, args) {
        return { text: `brain:${args.transcript ?? ''}` };
      },
    },
  });
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe('voice session backchannel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it('speaks a continuer on a reflective pause without taking a turn', async () => {
    vi.useFakeTimers();
    const ttsTexts: string[] = [];
    const events: Array<{ type: string; text?: string; state?: string }> = [];
    const recordedCosts: Array<{ operationName?: string }> = [];

    let transcriptHandler:
      | ((event: { text: string; final?: boolean }) => void | Promise<void>)
      | undefined;

    const voice = createBackchannelVoice();

    const baseProvider = createMockSTTProvider({
      connect(args) {
        transcriptHandler = args.onTranscript;
      },
    });
    const sttProvider = {
      ...baseProvider,
      capabilities: { ...baseProvider.capabilities, endpointDetection: true },
    };

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'backchannel-pause',
      ctx: createTestContext({
        ai: {
          ...mockAI(),
          async recordProviderCost(_entry: unknown, costContext?: { operationName?: string }) {
            recordedCosts.push({
              operationName: costContext?.operationName,
            });
          },
        },
      }),
      brainInput: {
        language: 'he',
        projectId: '00000000-0000-4000-a000-000000000001',
      },
      sttProvider,
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
    await transcriptHandler?.({
      text: 'אני נולדתי בירושלים וגדלתי שם',
      final: false,
    });
    await controller.handleAudioChunk(speechChunk);
    await vi.advanceTimersByTimeAsync(30);
    await flushMicrotasks();

    expect(ttsTexts.length).toBe(1);
    expect(['מהמ', 'כן']).toContain(ttsTexts[0]);
    expect(controller.turnCount).toBe(0);
    expect(events.some((event) => event.type === 'assistant.delta')).toBe(false);
    expect(events.some((event) => event.type === 'agent.state' && event.state === 'Playing')).toBe(
      false,
    );
    expect(recordedCosts.some((entry) => entry.operationName === 'voice.backchannel')).toBe(true);

    await controller.dispose();
  });

  it('aborts an in-flight backchannel when the user resumes speaking', async () => {
    vi.useFakeTimers();
    const ttsTexts: string[] = [];
    let releaseStream: (() => void) | undefined;

    let transcriptHandler:
      | ((event: { text: string; final?: boolean }) => void | Promise<void>)
      | undefined;

    const voice = createBackchannelVoice();

    const baseProvider = createMockSTTProvider({
      connect(args) {
        transcriptHandler = args.onTranscript;
      },
    });
    const sttProvider = {
      ...baseProvider,
      capabilities: { ...baseProvider.capabilities, endpointDetection: true },
    };

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'backchannel-resume',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider,
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text) {
          ttsTexts.push(text);
          await new Promise<void>((resolve) => {
            releaseStream = resolve;
          });
          yield new Uint8Array([1, 2]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    await controller.hello();
    await transcriptHandler?.({
      text: 'אני נולדתי בירושלים וגדלתי שם',
      final: false,
    });
    await controller.handleAudioChunk(speechChunk);
    await vi.advanceTimersByTimeAsync(30);
    await flushMicrotasks();
    expect(ttsTexts.length).toBe(1);

    await transcriptHandler?.({
      text: 'עם המשפחה שלי',
      final: false,
    });
    releaseStream?.();
    await flushMicrotasks();

    expect(controller.turnCount).toBe(0);
    expect(ttsTexts.length).toBe(1);
    expect(['מהמ', 'כן']).toContain(ttsTexts[0]);

    await controller.dispose();
  });

  it('selects backchannel phrases by detected language', async () => {
    vi.useFakeTimers();
    const ttsTexts: string[] = [];

    let transcriptHandler:
      | ((event: { text: string; final?: boolean; language?: string }) => void | Promise<void>)
      | undefined;

    const voice = createBackchannelVoice({
      backchannelPhrases: { he: ['מהמ'], en: ['mm-hm'] },
    });

    const baseProvider = createMockSTTProvider({
      connect(args) {
        transcriptHandler = args.onTranscript;
      },
    });
    const sttProvider = {
      ...baseProvider,
      capabilities: { ...baseProvider.capabilities, endpointDetection: true },
    };

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'backchannel-lang',
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
    await transcriptHandler?.({
      text: 'I was born in Jerusalem and grew up there',
      final: false,
      language: 'en',
    });
    await controller.handleAudioChunk(speechChunk);
    await vi.advanceTimersByTimeAsync(30);
    await flushMicrotasks();

    expect(ttsTexts).toEqual(['mm-hm']);

    await controller.dispose();
  });

  it('does not emit a backchannel while endpoint grace is active', async () => {
    vi.useFakeTimers();
    const ttsTexts: string[] = [];

    let transcriptHandler:
      | ((event: { text: string; final?: boolean }) => void | Promise<void>)
      | undefined;
    let endpointHandler: (() => void) | undefined;

    const voice = createBackchannelVoice();

    const baseProvider = createMockSTTProvider({
      connect(args) {
        transcriptHandler = args.onTranscript;
        endpointHandler = () => {
          void args.onEndpoint?.();
        };
      },
    });
    const sttProvider = {
      ...baseProvider,
      capabilities: { ...baseProvider.capabilities, endpointDetection: true },
    };

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'backchannel-grace',
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
    await transcriptHandler?.({
      text: 'אני נולדתי בירושלים וגדלתי שם',
      final: false,
    });
    await controller.handleAudioChunk(speechChunk);
    endpointHandler?.();
    await vi.advanceTimersByTimeAsync(40);
    await flushMicrotasks();

    expect(ttsTexts).toEqual([]);
    expect(controller.turnCount).toBe(0);

    await controller.dispose();
  });

  it('does not emit when backchannelEnabled is unset', async () => {
    vi.useFakeTimers();
    const ttsTexts: string[] = [];

    let transcriptHandler:
      | ((event: { text: string; final?: boolean }) => void | Promise<void>)
      | undefined;

    const voice = createBackchannelVoice({ backchannelEnabled: undefined });

    const baseProvider = createMockSTTProvider({
      connect(args) {
        transcriptHandler = args.onTranscript;
      },
    });
    const sttProvider = {
      ...baseProvider,
      capabilities: { ...baseProvider.capabilities, endpointDetection: true },
    };

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'backchannel-off',
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
    await transcriptHandler?.({
      text: 'אני נולדתי בירושלים וגדלתי שם',
      final: false,
    });
    await controller.handleAudioChunk(speechChunk);
    await vi.advanceTimersByTimeAsync(30);
    await flushMicrotasks();

    expect(ttsTexts).toEqual([]);

    await controller.dispose();
  });

  it('does not emit a backchannel after dispose or transport loss', async () => {
    vi.useFakeTimers();
    const ttsTexts: string[] = [];

    let transcriptHandler:
      | ((event: { text: string; final?: boolean }) => void | Promise<void>)
      | undefined;

    const voice = createBackchannelVoice();

    const baseProvider = createMockSTTProvider({
      connect(args) {
        transcriptHandler = args.onTranscript;
      },
    });
    const sttProvider = {
      ...baseProvider,
      capabilities: { ...baseProvider.capabilities, endpointDetection: true },
    };

    const controller = new VoiceSessionController({
      voice,
      sessionId: 'backchannel-dispose',
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
    await transcriptHandler?.({
      text: 'אני נולדתי בירושלים וגדלתי שם',
      final: false,
    });
    await controller.handleAudioChunk(speechChunk);
    await controller.dispose();
    await vi.advanceTimersByTimeAsync(30);
    await flushMicrotasks();
    expect(ttsTexts).toEqual([]);

    const lost = new VoiceSessionController({
      voice,
      sessionId: 'backchannel-lost',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider: {
        ...createMockSTTProvider({
          connect(args) {
            transcriptHandler = args.onTranscript;
          },
        }),
        capabilities: { ...baseProvider.capabilities, endpointDetection: true },
      },
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text) {
          ttsTexts.push(text);
          yield new Uint8Array([1, 2]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    await lost.hello();
    await transcriptHandler?.({
      text: 'אני נולדתי בירושלים וגדלתי שם',
      final: false,
    });
    await lost.handleAudioChunk(speechChunk);
    await lost.notifyTransportLost();
    await vi.advanceTimersByTimeAsync(30);
    await flushMicrotasks();
    expect(ttsTexts).toEqual([]);
    await lost.dispose();
  });
});
