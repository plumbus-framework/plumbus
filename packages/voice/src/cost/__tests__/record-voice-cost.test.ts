import { describe, expect, it, vi } from 'vitest';
import { recordVoiceCost } from '../record-voice-cost.js';

describe('recordVoiceCost', () => {
  it('records known pricing with costContext', async () => {
    const recordProviderCost = vi.fn(async () => {});

    const result = await recordVoiceCost(
      { ai: { recordProviderCost } },
      {
        operation: 'synthesize',
        provider: 'openai',
        model: 'tts-1',
        mediaUsage: { characters: 120 },
        latencyMs: 500,
        costContext: {
          projectId: 'voice-project',
          serviceArea: 'voice',
          operationName: 'voice.tts',
          relatedEntityType: 'voice_session',
          relatedEntityId: 'session-1',
        },
      },
    );

    expect(result.pricingKnown).toBe(true);
    expect(result.cost).toBeGreaterThan(0);
    expect(recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'synthesize',
        provider: 'openai',
        model: 'tts-1',
        mediaUsage: { characters: 120 },
        cost: result.cost,
        status: undefined,
      }),
      {
        projectId: 'voice-project',
        serviceArea: 'voice',
        operationName: 'voice.tts',
        relatedEntityType: 'voice_session',
        relatedEntityId: 'session-1',
      },
    );
  });

  it('records null cost for unknown models', async () => {
    const recordProviderCost = vi.fn(async () => {});

    const result = await recordVoiceCost(
      { ai: { recordProviderCost } },
      {
        operation: 'transcribe',
        provider: 'custom-stt',
        model: 'unknown-model',
        mediaUsage: { audioInputSeconds: 30 },
        latencyMs: 100,
      },
    );

    expect(result.pricingKnown).toBe(false);
    expect(result.cost).toBeNull();
    expect(recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'unknown-model',
        cost: null,
      }),
      undefined,
    );
  });

  it('forwards failed status and errorMessage', async () => {
    const recordProviderCost = vi.fn(async () => {});

    await recordVoiceCost(
      { ai: { recordProviderCost } },
      {
        operation: 'transcribe',
        provider: 'soniox',
        model: 'soniox-stt',
        mediaUsage: { audioInputSeconds: 5 },
        latencyMs: 50,
        status: 'failed',
        errorMessage: 'upstream timeout',
      },
    );

    expect(recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'upstream timeout',
      }),
      undefined,
    );
  });
});
