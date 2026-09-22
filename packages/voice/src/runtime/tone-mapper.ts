import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { DeliveryTone } from '../types/voice.js';
import type { ResolvedDeliveryTone } from './delivery-tone.js';

export interface MappedDeliveryTone extends ResolvedDeliveryTone {
  providerParams?: unknown;
}

export function mapDeliveryToneForProvider(
  ttsProvider: TTSProvider,
  resolved: ResolvedDeliveryTone,
): MappedDeliveryTone {
  if (!resolved.tone) {
    return { profileId: resolved.profileId, tone: undefined, providerParams: undefined };
  }

  return {
    profileId: resolved.profileId,
    tone: resolved.tone,
    providerParams: ttsProvider.mapDeliveryTone(resolved.tone),
  };
}

export function applyDeliveryToneToText(
  ttsProvider: TTSProvider,
  text: string,
  tone: DeliveryTone | undefined,
): string {
  if (!tone || !ttsProvider.applyDeliveryToText) return text;
  return ttsProvider.applyDeliveryToText(text, tone);
}

/**
 * @deprecated Test-only shim — production code should call `ttsProvider.mapDeliveryTone`.
 */
export function mapToneToTtsParams(ttsProvider: TTSProvider, tone: DeliveryTone): unknown {
  return ttsProvider.mapDeliveryTone(tone);
}
