import type { VoicePricingEntry } from '@plumbus/voice';

export const LIVEKIT_VOICE_PRICING: VoicePricingEntry = {
  model: 'livekit-cloud',
  operation: 'transport',
  unit: 'participantMinutes',
  usdPerUnit: 0.02,
};

export function calculateLiveKitTransportUsd(args: {
  connectedAt: Date;
  disconnectedAt: Date;
  participantCount?: number;
}): number {
  const wallClockMinutes = Math.max(
    0,
    (args.disconnectedAt.getTime() - args.connectedAt.getTime()) / 60_000,
  );
  const participants = args.participantCount ?? 2;
  const participantMinutes = wallClockMinutes * participants;
  if (participantMinutes <= 0) {
    return 0;
  }
  return roundUsd(participantMinutes * LIVEKIT_VOICE_PRICING.usdPerUnit);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
