import { describe, expect, it, vi } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import { recordDirectUtteranceCost, recordProviderUsage } from '../record-provider-usage.js';

describe('recordProviderUsage', () => {
  const voice = defineVoice({
    name: 'pricedVoice',
    access: {},
    transport: { provider: 'websocket' },
    stt: { provider: 'openai-whisper', model: 'whisper-1' },
    tts: { provider: 'openai', model: 'tts-1', voiceId: 'voice-1' },
    brain: {
      async run() {
        return { text: 'ok' };
      },
    },
  });

  it('maps usage models via provider knownModels and threads projectId', async () => {
    const recordProviderCost = vi.fn(async () => {});
    const ctx = { ai: { recordProviderCost } };

    await recordProviderUsage(
      ctx,
      {
        capabilities: {
          id: 'openai-whisper',
          kind: 'stt',
          displayName: 'Whisper',
          credentialSchema: [],
          hosting: 'cloud',
          execution: 'server',
          streaming: false,
          languages: 'multilingual',
          knownModels: [
            {
              id: 'whisper-1',
              displayName: 'Whisper 1',
              streaming: false,
              costModelKey: 'whisper-1',
            },
          ],
        },
        usage() {
          return [
            {
              provider: 'openai-whisper',
              kind: 'transcribe' as const,
              quantity: 12,
              unit: 'seconds' as const,
              model: 'whisper-1',
            },
          ];
        },
      },
      true,
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        projectId: 'proj-1',
        stt: voice.stt,
      },
    );

    await recordProviderUsage(
      ctx,
      {
        capabilities: {
          id: 'openai',
          kind: 'tts',
          displayName: 'OpenAI',
          credentialSchema: [],
          hosting: 'cloud',
          execution: 'server',
          streaming: true,
          toneSupport: 'none',
          deliveryAxes: [],
          deliveryMode: 'none',
          knownModels: [
            { id: 'tts-1', displayName: 'tts-1', streaming: true, costModelKey: 'tts-1' },
          ],
        },
        usage() {
          return [
            {
              provider: 'openai',
              kind: 'synthesize' as const,
              quantity: 80,
              unit: 'characters' as const,
              model: 'tts-1',
            },
          ];
        },
      },
      true,
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        projectId: 'proj-1',
        tts: voice.tts,
      },
    );

    expect(recordProviderCost).toHaveBeenCalledTimes(2);
    expect(recordProviderCost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operation: 'transcribe',
        model: 'whisper-1',
        mediaUsage: { audioInputSeconds: 12 },
      }),
      {
        projectId: 'proj-1',
        serviceArea: 'voice',
        operationName: 'voice.transcribe',
        relatedEntityType: 'InterviewSession',
        relatedEntityId: 'session-1',
      },
    );
    expect(recordProviderCost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: 'synthesize',
        model: 'tts-1',
        mediaUsage: { characters: 80 },
      }),
      {
        projectId: 'proj-1',
        serviceArea: 'voice',
        operationName: 'voice.synthesize',
        relatedEntityType: 'InterviewSession',
        relatedEntityId: 'session-1',
      },
    );
  });
});

describe('recordDirectUtteranceCost', () => {
  it('records auxiliary TTS from character count using the configured model id', async () => {
    const recordProviderCost = vi.fn(async () => {});
    const ctx = { ai: { recordProviderCost } };

    await recordDirectUtteranceCost(ctx, {
      text: 'מהמ',
      projectId: 'proj-9',
      sessionId: 'session-9',
      operationName: 'voice.hearing_repair',
      tts: { provider: 'openai', model: 'tts-1', voiceId: 'v1' },
      provider: 'openai',
    });

    expect(recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'synthesize',
        model: 'tts-1',
        mediaUsage: { characters: 3 },
      }),
      {
        projectId: 'proj-9',
        serviceArea: 'voice',
        operationName: 'voice.hearing_repair',
        relatedEntityType: 'InterviewSession',
        relatedEntityId: 'session-9',
      },
    );
  });
});
