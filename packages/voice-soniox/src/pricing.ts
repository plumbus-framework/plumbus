import type { VoicePricingEntry } from '@plumbus/voice/provider-kit';

/**
 * Ledger pricing for Soniox voice providers.
 *
 * Soniox TTS bills by tokens (~$0.70/hour of generated speech). The voice
 * ledger unit is characters, so `soniox-tts` is an approximate conversion
 * (~50k chars/hour → ~$0.000014/character) — not exact vendor token billing.
 */
export const SONIOX_VOICE_PRICING: Readonly<Record<string, VoicePricingEntry>> = {
  'soniox-stt': {
    model: 'soniox-stt',
    operation: 'transcribe',
    unit: 'audioInputSeconds',
    usdPerUnit: 0.0001667,
  },
  'soniox-tts': {
    model: 'soniox-tts',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000014,
  },
};
