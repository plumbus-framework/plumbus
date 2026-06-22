import { describe, expect, it } from 'vitest';
import { deriveLedgerUsage } from '../derive-ledger-usage.js';

const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe('deriveLedgerUsage', () => {
  it('maps STT audio input seconds', () => {
    expect(
      deriveLedgerUsage({
        operation: 'transcribe',
        usage: zeroUsage,
        mediaUsage: { audioInputSeconds: 32.4 },
      }),
    ).toEqual({ usageKind: 'audio_seconds', usageQuantity: 32.4 });
  });

  it('maps TTS characters', () => {
    expect(
      deriveLedgerUsage({
        operation: 'synthesize',
        usage: zeroUsage,
        mediaUsage: { characters: 108 },
      }),
    ).toEqual({ usageKind: 'characters', usageQuantity: 108 });
  });

  it('maps transport participant minutes with optional connection minutes', () => {
    expect(
      deriveLedgerUsage({
        operation: 'transport',
        usage: zeroUsage,
        mediaUsage: { connectionMinutes: 1.2, participantMinutes: 2.4 },
      }),
    ).toEqual({
      usageKind: 'participant_minutes',
      usageQuantity: 2.4,
      usageQuantitySecondary: 1.2,
    });
  });

  it('maps connection minutes when participant minutes are absent', () => {
    expect(
      deriveLedgerUsage({
        operation: 'transport',
        usage: zeroUsage,
        mediaUsage: { connectionMinutes: 3.5 },
      }),
    ).toEqual({ usageKind: 'connection_minutes', usageQuantity: 3.5 });
  });

  it('falls back to LLM token counts when media usage is empty', () => {
    expect(
      deriveLedgerUsage({
        operation: 'generate',
        usage: { inputTokens: 2243, outputTokens: 44, totalTokens: 2287 },
      }),
    ).toEqual({
      usageKind: 'llm_tokens',
      usageQuantity: 2243,
      usageQuantitySecondary: 44,
    });
  });

  it('prefers audio input seconds over characters when both are present', () => {
    expect(
      deriveLedgerUsage({
        operation: 'transcribe',
        usage: zeroUsage,
        mediaUsage: { audioInputSeconds: 10, characters: 50 },
      }),
    ).toEqual({ usageKind: 'audio_seconds', usageQuantity: 10 });
  });

  it('maps audio output seconds when only output audio is billed', () => {
    expect(
      deriveLedgerUsage({
        operation: 'synthesize',
        usage: zeroUsage,
        mediaUsage: { audioOutputSeconds: 12 },
      }),
    ).toEqual({ usageKind: 'audio_output_seconds', usageQuantity: 12 });
  });
});
