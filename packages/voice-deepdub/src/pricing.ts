import type { VoicePricingEntry } from '@plumbus/voice';

export const DEEPDUB_VOICE_PRICING: VoicePricingEntry = {
  model: 'deepdub-phantom-x',
  operation: 'synthesize',
  unit: 'characters',
  usdPerUnit: 0.000024,
};
