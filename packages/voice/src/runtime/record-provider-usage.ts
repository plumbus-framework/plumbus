import type { ExecutionContext } from '@plumbus/core';
import {
  resolveSttCostModelKey,
  resolveTtsCostModelKey,
} from '../cost/estimate-voice-turn-cost.js';
import { recordVoiceCost } from '../cost/record-voice-cost.js';
import type { STTProvider } from '../providers/base/stt-provider.js';
import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { VoiceCostOperation, VoiceMediaUsage } from '../types/cost.js';
import type { VoiceModelOption } from '../types/provider.js';
import type { VoiceSttConfig, VoiceTtsConfig } from '../types/voice.js';

export type DirectUtteranceCostOperation =
  | 'voice.backchannel'
  | 'voice.hearing_repair'
  | 'voice.replay';

export async function recordProviderUsage(
  ctx: ExecutionContext,
  provider: Pick<STTProvider | TTSProvider, 'usage' | 'capabilities'>,
  billable: boolean,
  args: {
    sessionId: string;
    turnId: string;
    text?: string;
    projectId?: string;
    stt?: VoiceSttConfig;
    tts?: VoiceTtsConfig;
  },
): Promise<void> {
  if (!billable) return;

  const usageRecords = provider.usage?.() ?? [];
  const capabilities = provider.capabilities as { knownModels?: readonly VoiceModelOption[] };
  const knownModels = capabilities.knownModels;
  for (const record of usageRecords) {
    const operation = mapUsageKind(record.kind);
    const mediaUsage = mapMediaUsage(record, args.text);
    const rawModel = record.model ?? record.provider;
    const model = resolvePricingModelKey(operation, rawModel, args, knownModels);

    await recordVoiceCost(ctx, {
      operation,
      provider: record.provider,
      model,
      mediaUsage,
      latencyMs: 0,
      costContext: {
        projectId: args.projectId,
        serviceArea: 'voice',
        operationName: resolveOperationName(operation),
        relatedEntityType: 'InterviewSession',
        relatedEntityId: args.sessionId,
      },
    });
  }
}

export async function recordDirectUtteranceCost(
  ctx: ExecutionContext,
  args: {
    text: string;
    projectId?: string;
    sessionId: string;
    operationName: DirectUtteranceCostOperation;
    tts: VoiceTtsConfig;
    provider: string;
  },
): Promise<void> {
  const characters = args.text.trim().length;
  if (characters === 0) {
    return;
  }

  const model = resolveTtsCostModelKey(args.tts) ?? args.tts.model;
  if (!model) {
    return;
  }

  await recordVoiceCost(ctx, {
    operation: 'synthesize',
    provider: args.provider,
    model,
    mediaUsage: { characters },
    latencyMs: 0,
    costContext: {
      projectId: args.projectId,
      serviceArea: 'voice',
      operationName: args.operationName,
      relatedEntityType: 'InterviewSession',
      relatedEntityId: args.sessionId,
    },
  });
}

function resolvePricingModelKey(
  operation: VoiceCostOperation,
  rawModel: string,
  args: { stt?: VoiceSttConfig; tts?: VoiceTtsConfig },
  knownModels?: readonly VoiceModelOption[],
): string {
  if (operation === 'transcribe' && args.stt) {
    return resolveSttCostModelKey(args.stt, knownModels) ?? rawModel;
  }
  if (operation === 'synthesize' && args.tts) {
    return resolveTtsCostModelKey(args.tts, knownModels) ?? rawModel;
  }
  return rawModel;
}

function resolveOperationName(operation: VoiceCostOperation): string {
  if (operation === 'transcribe') {
    return 'voice.transcribe';
  }
  if (operation === 'synthesize') {
    return 'voice.synthesize';
  }
  return 'voice.transport';
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
