import { describe, expect, it, vi } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import { recordDirectUtteranceCost, recordProviderUsage } from '../record-provider-usage.js';

describe('recordProviderUsage', () => {
  const voice = defineVoice({
    name: 'pricedVoice',
    access: {},
    transport: { provider: 'websocket' },
    stt: { provider: 'soniox', model: 'stt-rt-v5' },
    tts: { provider: 'deepdub', model: 'dd-etts-3.2', voiceId: 'voice-1' },
    brain: {
      async run() {
        return { text: 'ok' };
      },
    },
  });

  it('maps usage models to pricing keys and threads projectId with readable operation names', async () => {
    const recordProviderCost = vi.fn(async () => {});
    const ctx = { ai: { recordProviderCost } };

    await recordProviderUsage(
      ctx,
      {
        usage() {
          return [
            {
              provider: 'soniox',
              kind: 'transcribe' as const,
              quantity: 12,
              unit: 'seconds' as const,
              model: 'stt-rt-v5',
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
        usage() {
          return [
            {
              provider: 'deepdub',
              kind: 'synthesize' as const,
              quantity: 80,
              unit: 'characters' as const,
              model: 'dd-etts-3.2',
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
        model: 'soniox-stt',
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
        model: 'deepdub-phantom-x',
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
  it('records auxiliary TTS from character count', async () => {
    const recordProviderCost = vi.fn(async () => {});
    const ctx = { ai: { recordProviderCost } };

    await recordDirectUtteranceCost(ctx, {
      text: 'מהמ',
      projectId: 'proj-9',
      sessionId: 'session-9',
      operationName: 'voice.backchannel',
      tts: { provider: 'deepdub', model: 'dd-etts-3.2', voiceId: 'v1' },
      provider: 'deepdub',
    });

    expect(recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'synthesize',
        model: 'deepdub-phantom-x',
        mediaUsage: { characters: 3 },
      }),
      {
        projectId: 'proj-9',
        serviceArea: 'voice',
        operationName: 'voice.backchannel',
        relatedEntityType: 'InterviewSession',
        relatedEntityId: 'session-9',
      },
    );
  });
});
