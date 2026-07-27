import type { ExecutionContext } from '@plumbus/core';
import { recordVoiceCost } from '@plumbus/voice';
import { calculateLiveKitTransportUsd } from '../pricing.js';

export async function recordLiveKitTransportCost(
  ctx: Pick<ExecutionContext, 'ai'>,
  args: {
    sessionId: string;
    connectedAt: Date;
    disconnectedAt: Date;
    participantCount?: number;
    costContext?: Record<string, unknown>;
  },
): Promise<void> {
  const wallClockMinutes = Math.max(
    0,
    (args.disconnectedAt.getTime() - args.connectedAt.getTime()) / 60_000,
  );
  const participants = args.participantCount ?? 2;
  const cost = calculateLiveKitTransportUsd({
    connectedAt: args.connectedAt,
    disconnectedAt: args.disconnectedAt,
    participantCount: participants,
  });

  await recordVoiceCost(ctx, {
    operation: 'transport',
    provider: 'livekit',
    model: 'livekit-cloud',
    mediaUsage: {
      connectionMinutes: wallClockMinutes,
      participantMinutes: wallClockMinutes * participants,
    },
    cost,
    latencyMs: 0,
    costContext: {
      serviceArea: 'voice',
      operationName: 'voice.transport',
      relatedEntityId: args.sessionId,
      ...args.costContext,
    },
  });
}
