import type { ExecutionContext } from '@plumbus/core';
import { recordVoiceCost } from '../cost/record-voice-cost.js';
import type { STTProvider } from '../providers/base/stt-provider.js';
import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { VoiceCostOperation, VoiceMediaUsage } from '../types/cost.js';

export async function recordProviderUsage(
  ctx: ExecutionContext,
  provider: Pick<STTProvider | TTSProvider, 'usage'>,
  billable: boolean,
  args: {
    sessionId: string;
    turnId: string;
    text?: string;
  },
): Promise<void> {
  if (!billable) return;

  const usageRecords = provider.usage?.() ?? [];
  for (const record of usageRecords) {
    const operation = mapUsageKind(record.kind);
    const mediaUsage = mapMediaUsage(record, args.text);
    const model = record.model ?? record.provider;

    await recordVoiceCost(ctx, {
      operation,
      provider: record.provider,
      model,
      mediaUsage,
      latencyMs: 0,
      costContext: {
        serviceArea: 'voice',
        operationName: args.turnId,
        relatedEntityId: args.sessionId,
      },
    });
  }
}

function mapUsageKind(kind: string): VoiceCostOperation {
  if (kind === 'transcribe' || kind === 'synthesize' || kind === 'transport') {
    return kind;
  }
  return 'synthesize';
}

function mapMediaUsage(
  record: {
    kind: string;
    quantity: number;
    unit: string;
  },
  text?: string,
): VoiceMediaUsage {
  switch (record.unit) {
    case 'seconds':
      return record.kind === 'transcribe'
        ? { audioInputSeconds: record.quantity }
        : { audioOutputSeconds: record.quantity };
    case 'minutes':
      return record.kind === 'transport'
        ? { connectionMinutes: record.quantity, participantMinutes: record.quantity }
        : { connectionMinutes: record.quantity };
    case 'characters':
      return { characters: record.quantity };
    default:
      return { characters: text?.length ?? record.quantity };
  }
}
