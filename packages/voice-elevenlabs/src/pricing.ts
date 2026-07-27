import type { VoicePricingEntry } from '@plumbus/voice';

export const ELEVENLABS_VOICE_PRICING: readonly VoicePricingEntry[] = [
  {
    model: 'eleven_flash_v2_5',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000016,
  },
  {
    model: 'eleven_v3',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.00003,
  },
];
