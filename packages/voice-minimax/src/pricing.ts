import type { VoicePricingEntry } from '@plumbus/voice';

export const MINIMAX_VOICE_PRICING: readonly VoicePricingEntry[] = [
  {
    model: 'minimax-speech-2.8-turbo',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000018,
  },
  {
    model: 'minimax-speech-2.8-hd',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000024,
  },
];
