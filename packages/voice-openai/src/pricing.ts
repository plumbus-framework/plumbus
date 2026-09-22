import type { VoicePricingEntry } from '@plumbus/voice/provider-kit';

export const OPENAI_VOICE_PRICING: Readonly<Record<string, VoicePricingEntry>> = {
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
};
