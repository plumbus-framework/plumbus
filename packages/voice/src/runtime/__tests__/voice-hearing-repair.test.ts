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

  it('runs a normal turn for a low-confidence transcript when no hook is configured', async () => {
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

    // The framework never judges transcript content on its own: no repair
    // speech, and the low-confidence transcript still becomes a normal turn
    // (the only synthesized text is the brain's reply).
    expect(brainCalls).toEqual(['John דוד']);
    expect(ttsTexts).toEqual(['brain response']);
  });
});

describe('voice session hearing repair — app onHearingRepair hook', () => {
  function setupRepairSession(voiceConfig: {
    onHearingRepair?: Parameters<typeof defineVoice>[0]['onHearingRepair'];
    toneProfiles?: Parameters<typeof defineVoice>[0]['toneProfiles'];
  }) {
    const ttsCalls: Array<{ text: string; params: unknown }> = [];
    const brainCalls: string[] = [];

    const voice = defineVoice({
      name: 'repairHookVoice',
      access: {},
      transport: { provider: 'livekit', mode: 'continuous', audioFormat: 'pcm16-16k' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run(_ctx, args) {
          brainCalls.push(args.transcript ?? '');
          return { text: 'brain response' };
        },
      },
      ...(voiceConfig.toneProfiles ? { toneProfiles: voiceConfig.toneProfiles } : {}),
      ...(voiceConfig.onHearingRepair ? { onHearingRepair: voiceConfig.onHearingRepair } : {}),
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
      sessionId: 'repair-hook',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider,
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text, params) {
          ttsCalls.push({ text, params });
          yield new Uint8Array([1, 2]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    return { controller, endpointHandler: () => endpointHandler?.(), ttsCalls, brainCalls };
  }

  async function triggerEmptyEndpointRepair(session: ReturnType<typeof setupRepairSession>) {
    await session.controller.hello();
    await session.controller.handleAudioChunk(encodePcm16([0.5, -0.5, 0.4, -0.4]));
    session.endpointHandler();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('speaks the hook-provided text instead of the built-in default', async () => {
    const session = setupRepairSession({
      onHearingRepair: () => 'custom app repair line',
    });

    await triggerEmptyEndpointRepair(session);

    expect(session.ttsCalls.map((call) => call.text)).toEqual(['custom app repair line']);
    expect(session.brainCalls).toEqual([]);
  });

  it('passes reason, detected language, and session id to the hook', async () => {
    const hookArgs: Array<{ reason?: string; language?: string; sessionId?: string }> = [];
    const session = setupRepairSession({
      onHearingRepair: (_ctx, args) => {
        hookArgs.push(args);
        return 'custom app repair line';
      },
    });

    await triggerEmptyEndpointRepair(session);

    expect(hookArgs).toEqual([
      { reason: 'empty', transcript: '', language: 'he', sessionId: 'repair-hook' },
    ]);
  });

  it('suppresses the repair speech when the hook returns undefined', async () => {
    const session = setupRepairSession({
      onHearingRepair: () => undefined,
    });

    await triggerEmptyEndpointRepair(session);

    expect(session.ttsCalls).toEqual([]);
    expect(session.brainCalls).toEqual([]);
  });

  it('passes the hook-provided tone through the provider tone mapping to TTS', async () => {
    const session = setupRepairSession({
      toneProfiles: {
        apologetic_repair: { pace: 'slow', warmth: 'high', energy: 'low', emotion: 'apologetic' },
      },
      onHearingRepair: () => ({
        text: 'custom app repair line',
        tone: { profile: 'apologetic_repair', targetGender: 'female' },
      }),
    });

    await triggerEmptyEndpointRepair(session);

    expect(session.ttsCalls).toHaveLength(1);
    expect(session.ttsCalls[0]?.params).toEqual({
      tone: {
        pace: 'slow',
        warmth: 'high',
        energy: 'low',
        emotion: 'apologetic',
        profile: 'apologetic_repair',
        targetGender: 'female',
      },
    });
  });

  it('falls back to the built-in default line when the hook throws', async () => {
    const session = setupRepairSession({
      onHearingRepair: () => {
        throw new Error('app hook exploded');
      },
    });

    await triggerEmptyEndpointRepair(session);

    expect(session.ttsCalls.map((call) => call.text)).toEqual([
      'לא הצלחתי לשמוע את זה ברור. אפשר לחזור שוב?',
    ]);
  });

  // ── low_confidence signals: the app hook owns the content decision ──

  function setupLowConfidenceSession(voiceConfig: {
    onHearingRepair?: Parameters<typeof defineVoice>[0]['onHearingRepair'];
    toneProfiles?: Parameters<typeof defineVoice>[0]['toneProfiles'];
  }) {
    const ttsCalls: Array<{ text: string; params: unknown }> = [];
    const brainCalls: string[] = [];

    const voice = defineVoice({
      name: 'repairLowConfidenceVoice',
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
      ...(voiceConfig.toneProfiles ? { toneProfiles: voiceConfig.toneProfiles } : {}),
      ...(voiceConfig.onHearingRepair ? { onHearingRepair: voiceConfig.onHearingRepair } : {}),
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
      sessionId: 'repair-low-confidence',
      ctx: createTestContext(),
      brainInput: { language: 'he' },
      sttProvider,
      ttsProvider: createMockTTSProvider({
        async *synthesizeStream(text, params) {
          ttsCalls.push({ text, params });
          yield new Uint8Array([1]);
        },
      }),
      transportProvider: createMockTransportProvider(),
      onEvent: async () => {},
    });

    return { controller, ttsCalls, brainCalls };
  }

  async function triggerLowConfidence(session: ReturnType<typeof setupLowConfidenceSession>) {
    await session.controller.hello();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('passes the raw transcript, confidence, and language to the hook', async () => {
    const hookArgs: Array<{
      reason?: string;
      transcript?: string;
      confidence?: number;
      language?: string;
      sessionId?: string;
    }> = [];
    const session = setupLowConfidenceSession({
      onHearingRepair: (_ctx, args) => {
        hookArgs.push(args);
        return undefined;
      },
    });

    await triggerLowConfidence(session);

    expect(hookArgs).toEqual([
      {
        reason: 'low_confidence',
        transcript: 'John דוד',
        confidence: 0.4,
        language: 'he',
        sessionId: 'repair-low-confidence',
      },
    ]);
  });

  it('speaks the hook-provided text and tone for a low-confidence repair', async () => {
    const session = setupLowConfidenceSession({
      toneProfiles: {
        apologetic_repair: { pace: 'slow', warmth: 'high', energy: 'low', emotion: 'apologetic' },
      },
      onHearingRepair: () => ({
        text: 'app spell-the-name line',
        tone: { profile: 'apologetic_repair', targetGender: 'male' },
      }),
    });

    await triggerLowConfidence(session);

    expect(session.ttsCalls).toEqual([
      {
        text: 'app spell-the-name line',
        params: {
          tone: {
            pace: 'slow',
            warmth: 'high',
            energy: 'low',
            emotion: 'apologetic',
            profile: 'apologetic_repair',
            targetGender: 'male',
          },
        },
      },
    ]);
    expect(session.brainCalls).toEqual([]);
  });

  it('lets the turn proceed normally when the hook suppresses a low-confidence repair', async () => {
    const session = setupLowConfidenceSession({
      onHearingRepair: () => undefined,
    });

    await triggerLowConfidence(session);

    expect(session.brainCalls).toEqual(['John דוד']);
    expect(session.ttsCalls.map((call) => call.text)).toEqual(['brain response']);
  });
});
