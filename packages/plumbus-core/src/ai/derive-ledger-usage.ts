import type { AICostRecord } from './cost-tracker.js';

export type LedgerUsageKind =
  | 'llm_tokens'
  | 'audio_seconds'
  | 'audio_output_seconds'
  | 'characters'
  | 'participant_minutes'
  | 'connection_minutes';

export interface DerivedLedgerUsage {
  usageKind: LedgerUsageKind;
  usageQuantity: number;
  usageQuantitySecondary?: number;
}

type DeriveLedgerUsageInput = Pick<AICostRecord, 'usage' | 'mediaUsage' | 'operation'>;

export function deriveLedgerUsage(record: DeriveLedgerUsageInput): DerivedLedgerUsage {
  const media = record.mediaUsage;
  const audioInputSeconds = media?.audioInputSeconds ?? 0;
  if (audioInputSeconds > 0) {
    return { usageKind: 'audio_seconds', usageQuantity: audioInputSeconds };
  }

  const audioOutputSeconds = media?.audioOutputSeconds ?? 0;
  if (audioOutputSeconds > 0) {
    return { usageKind: 'audio_output_seconds', usageQuantity: audioOutputSeconds };
  }

  const characters = media?.characters ?? 0;
  if (characters > 0) {
    return { usageKind: 'characters', usageQuantity: characters };
  }

  const participantMinutes = media?.participantMinutes ?? 0;
  if (participantMinutes > 0) {
    const connectionMinutes = media?.connectionMinutes;
    return connectionMinutes !== undefined && connectionMinutes > 0
      ? {
          usageKind: 'participant_minutes',
          usageQuantity: participantMinutes,
          usageQuantitySecondary: connectionMinutes,
        }
      : { usageKind: 'participant_minutes', usageQuantity: participantMinutes };
  }

  const connectionMinutes = media?.connectionMinutes ?? 0;
  if (connectionMinutes > 0) {
    return { usageKind: 'connection_minutes', usageQuantity: connectionMinutes };
  }

  return {
    usageKind: 'llm_tokens',
    usageQuantity: record.usage.inputTokens,
    usageQuantitySecondary: record.usage.outputTokens,
  };
}
