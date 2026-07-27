import type { VoicePricingEntry } from '@plumbus/voice';

export const SONIOX_VOICE_PRICING: VoicePricingEntry = {
  model: 'soniox-stt',
  operation: 'transcribe',
  unit: 'audioInputSeconds',
  usdPerUnit: 0.0001667,
};
