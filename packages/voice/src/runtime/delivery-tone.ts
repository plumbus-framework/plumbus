import type { ExecutionContext } from '@plumbus/core';
import type {
  DeliveryTone,
  ToneProfileId,
  VoiceDefinition,
  VoiceResolveToneArgs,
  VoiceResolveToneResult,
} from '../types/voice.js';

export interface ResolvedDeliveryTone {
  profileId?: ToneProfileId;
  tone?: DeliveryTone;
}

export async function resolveDeliveryTone(
  ctx: ExecutionContext,
  voice: VoiceDefinition,
  args: VoiceResolveToneArgs,
): Promise<ResolvedDeliveryTone> {
  if (!voice.resolveTone) return { tone: undefined };

  const resolved = await voice.resolveTone(ctx, args);
  return normalizeResolvedTone(voice, resolved);
}

export function normalizeResolvedTone(
  voice: VoiceDefinition,
  resolved: VoiceResolveToneResult,
): ResolvedDeliveryTone {
  if (!resolved) return { tone: undefined };

  if (typeof resolved === 'string') {
    return {
      profileId: resolved,
      tone: mergeDeliveryTone(voice.toneProfiles[resolved], { profile: resolved }),
    };
  }

  const profileId = resolved.profile;
  const baseTone = profileId ? voice.toneProfiles[profileId] : undefined;
  return {
    profileId,
    tone: mergeDeliveryTone(baseTone, resolved),
  };
}

export function mergeDeliveryTone(
  base: DeliveryTone | undefined,
  override: DeliveryTone | undefined,
): DeliveryTone | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
  };
}
