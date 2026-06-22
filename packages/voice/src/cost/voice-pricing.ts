import type { VoiceMediaUsage } from '../types/cost.js';

export type VoicePricingUnit =
  | 'audioInputSeconds'
  | 'audioInputMinutes'
  | 'audioOutputSeconds'
  | 'characters'
  | 'connectionMinutes'
  | 'participantMinutes';

export interface VoicePricingEntry {
  model: string;
  operation: 'transcribe' | 'synthesize' | 'transport';
  unit: VoicePricingUnit;
  usdPerUnit: number;
}

const VOICE_PRICING: Readonly<Record<string, VoicePricingEntry>> = {
  'soniox-stt': {
    model: 'soniox-stt',
    operation: 'transcribe',
    unit: 'audioInputSeconds',
    usdPerUnit: 0.0001667,
  },
  'whisper-1': {
    model: 'whisper-1',
    operation: 'transcribe',
    unit: 'audioInputSeconds',
    usdPerUnit: 0.0001,
  },
  'gpt-4o-transcribe': {
    model: 'gpt-4o-transcribe',
    operation: 'transcribe',
    unit: 'audioInputSeconds',
    usdPerUnit: 0.0001,
  },
  'gpt-realtime-whisper': {
    model: 'gpt-realtime-whisper',
    operation: 'transcribe',
    unit: 'audioInputMinutes',
    usdPerUnit: 0.006,
  },
  'deepdub-phantom-x': {
    model: 'deepdub-phantom-x',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000024,
  },
  'tts-1': {
    model: 'tts-1',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000015,
  },
  'tts-1-hd': {
    model: 'tts-1-hd',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.00003,
  },
  'minimax-speech-2.8-turbo': {
    model: 'minimax-speech-2.8-turbo',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000018,
  },
  'minimax-speech-2.8-hd': {
    model: 'minimax-speech-2.8-hd',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000024,
  },
  eleven_flash_v2_5: {
    model: 'eleven_flash_v2_5',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.000016,
  },
  eleven_v3: {
    model: 'eleven_v3',
    operation: 'synthesize',
    unit: 'characters',
    usdPerUnit: 0.00003,
  },
  'livekit-cloud': {
    model: 'livekit-cloud',
    operation: 'transport',
    unit: 'participantMinutes',
    usdPerUnit: 0.02,
  },
  websocket: {
    model: 'websocket',
    operation: 'transport',
    unit: 'participantMinutes',
    usdPerUnit: 0,
  },
};

export function listVoicePricing(): readonly VoicePricingEntry[] {
  return Object.values(VOICE_PRICING);
}

export function lookupVoicePricing(model: string): VoicePricingEntry | undefined {
  return VOICE_PRICING[model];
}

export function calculateVoiceCost(model: string, mediaUsage: VoiceMediaUsage): number {
  const pricing = lookupVoicePricing(model);
  if (!pricing) {
    return 0;
  }

  const quantity = resolveUsageQuantity(pricing.unit, mediaUsage);
  if (quantity <= 0) {
    return 0;
  }

  return roundUsd(quantity * pricing.usdPerUnit);
}

function resolveUsageQuantity(unit: VoicePricingUnit, mediaUsage: VoiceMediaUsage): number {
  switch (unit) {
    case 'audioInputSeconds':
      return mediaUsage.audioInputSeconds ?? 0;
    case 'audioInputMinutes':
      return (mediaUsage.audioInputSeconds ?? 0) / 60;
    case 'audioOutputSeconds':
      return mediaUsage.audioOutputSeconds ?? 0;
    case 'characters':
      return mediaUsage.characters ?? 0;
    case 'connectionMinutes':
      return mediaUsage.connectionMinutes ?? 0;
    case 'participantMinutes':
      return mediaUsage.participantMinutes ?? 0;
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
