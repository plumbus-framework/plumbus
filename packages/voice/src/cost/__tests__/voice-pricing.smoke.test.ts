import { describe, expect, it, vi } from 'vitest';
import { calculateVoiceCost, createVoiceSessionBudget, recordVoiceCost } from '../../index.js';

describe('voice pricing smoke', () => {
  it('calculates cost for known builtin models and returns 0 for unknown models', () => {
    expect(calculateVoiceCost('websocket', { participantMinutes: 4 })).toBe(0);
    expect(calculateVoiceCost('whisper-1', { audioInputSeconds: 60 })).toBe(0);
    expect(calculateVoiceCost('unknown-model', { audioInputSeconds: 60 })).toBe(0);
  });

  it('records provider cost with an explicit add-on cost override', async () => {
    const recordProviderCost = vi.fn(async () => {});

    const result = await recordVoiceCost(
      {
        ai: {
          recordProviderCost,
        },
      },
      {
        operation: 'transport',
        provider: 'livekit',
        model: 'livekit-cloud',
        mediaUsage: { connectionMinutes: 2, participantMinutes: 4 },
        latencyMs: 120_000,
        cost: 0.08,
        costContext: {
          projectId: 'voice-project',
          serviceArea: 'voice',
          operationName: 'voice.transport',
        },
      },
    );

    expect(result.pricingKnown).toBe(true);
    expect(result.cost).toBe(0.08);
    expect(recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'transport',
        provider: 'livekit',
        cost: 0.08,
        mediaUsage: { connectionMinutes: 2, participantMinutes: 4 },
      }),
      {
        projectId: 'voice-project',
        serviceArea: 'voice',
        operationName: 'voice.transport',
      },
    );
  });

  it('tracks session budget state without enforcing runtime behavior yet', () => {
    const budget = createVoiceSessionBudget({
      maxAudioInputSeconds: 30,
      maxParticipantMinutes: 5,
    });

    expect(budget.check({ audioInputSeconds: 10 }).allowed).toBe(true);
    budget.record({ audioInputSeconds: 10, participantMinutes: 2 });
    expect(budget.state.audioInputSeconds).toBe(10);
    expect(budget.check({ audioInputSeconds: 25 }).allowed).toBe(false);
  });
});
