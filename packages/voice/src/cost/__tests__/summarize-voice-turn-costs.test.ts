import { describe, expect, it } from 'vitest';
import {
  summarizeVoiceTurnCosts,
  type VoiceCostLedgerEntry,
} from '../summarize-voice-turn-costs.js';

function entry(
  operation: 'transcribe' | 'synthesize' | 'generate',
  cost: number | null,
  sessionId: string,
  turnId: string,
): VoiceCostLedgerEntry {
  return {
    record: {
      id: `${operation}-1`,
      timestamp: new Date(),
      model: operation,
      provider: 'test',
      operation,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cost,
      latencyMs: 1,
      status: 'success',
    },
    costContext: {
      relatedEntityId: sessionId,
      operationName: turnId,
    },
  };
}

describe('summarizeVoiceTurnCosts', () => {
  it('rolls up transcribe and synthesize rows for a turn', () => {
    const sessionId = 'session-1';
    const turnId = 'turn-1';
    const summary = summarizeVoiceTurnCosts(
      [entry('transcribe', 0.01, sessionId, turnId), entry('synthesize', 0.02, sessionId, turnId)],
      sessionId,
      turnId,
      { transportUsd: 0.06, turnCount: 2 },
    );

    expect(summary.transcribeUsd).toBe(0.01);
    expect(summary.synthesizeUsd).toBe(0.02);
    expect(summary.transportUsdAmortized).toBe(0.03);
    expect(summary.totalUsd).toBe(0.06);
    expect(summary.costAvailable).toBe(true);
  });
});
