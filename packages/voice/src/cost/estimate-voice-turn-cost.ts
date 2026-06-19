import type { VoiceModelOption } from '../types/provider.js';
import {
  DEEPDUB_TTS_MODELS,
  ELEVENLABS_TTS_MODELS,
  getVoiceModelOption,
  MINIMAX_TTS_MODELS,
  OPENAI_REALTIME_STT_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_WHISPER_STT_MODELS,
} from '../catalog/static-models.js';
import type { VoiceSttConfig, VoiceTtsConfig, VoiceDefinition } from '../types/voice.js';
import { calculateVoiceCost } from './voice-pricing.js';

const DEFAULT_AUDIO_INPUT_SECONDS = 30;
const DEFAULT_RESPONSE_CHARACTERS = 200;

const FREE_STT_PROVIDERS = new Set(['web-speech', 'mock-stt']);
const FREE_TTS_PROVIDERS = new Set(['browser-tts', 'mock-tts']);

const STT_PROVIDER_MODELS: Record<string, readonly VoiceModelOption[]> = {
  'openai-whisper': OPENAI_WHISPER_STT_MODELS,
  'openai-realtime': OPENAI_REALTIME_STT_MODELS,
};

const TTS_PROVIDER_MODELS: Record<string, readonly VoiceModelOption[]> = {
  openai: OPENAI_TTS_MODELS,
  deepdub: DEEPDUB_TTS_MODELS,
  minimax: MINIMAX_TTS_MODELS,
  elevenlabs: ELEVENLABS_TTS_MODELS,
};

export interface EstimateVoiceTurnCostInput {
  voice: VoiceDefinition;
  estimatedAudioInputSeconds?: number;
  estimatedResponseCharacters?: number;
}

export interface EstimateVoiceTurnCostResult {
  estimatedCostUsd: number;
  sttCostUsd: number;
  ttsCostUsd: number;
  sttModelKey?: string;
  ttsModelKey?: string;
}

export function estimateVoiceTurnCost(
  input: EstimateVoiceTurnCostInput,
): EstimateVoiceTurnCostResult {
  const audioInputSeconds = input.estimatedAudioInputSeconds ?? DEFAULT_AUDIO_INPUT_SECONDS;
  const characters = input.estimatedResponseCharacters ?? DEFAULT_RESPONSE_CHARACTERS;

  const sttModelKey = resolveSttCostModelKey(input.voice.stt);
  const ttsModelKey = resolveTtsCostModelKey(input.voice.tts);

  const sttCostUsd = sttModelKey ? calculateVoiceCost(sttModelKey, { audioInputSeconds }) : 0;
  const ttsCostUsd = ttsModelKey ? calculateVoiceCost(ttsModelKey, { characters }) : 0;

  return {
    estimatedCostUsd: roundUsd(sttCostUsd + ttsCostUsd),
    sttCostUsd: roundUsd(sttCostUsd),
    ttsCostUsd: roundUsd(ttsCostUsd),
    sttModelKey,
    ttsModelKey,
  };
}

function resolveSttCostModelKey(stt: VoiceSttConfig): string | undefined {
  if (FREE_STT_PROVIDERS.has(stt.provider)) {
    return undefined;
  }
  if (stt.provider === 'soniox') {
    return 'soniox-stt';
  }

  const models = STT_PROVIDER_MODELS[stt.provider];
  const option = getVoiceModelOption(models ?? [], stt.model);
  return option?.costModelKey ?? option?.id ?? stt.model;
}

function resolveTtsCostModelKey(tts: VoiceTtsConfig): string | undefined {
  if (FREE_TTS_PROVIDERS.has(tts.provider)) {
    return undefined;
  }

  const models = TTS_PROVIDER_MODELS[tts.provider];
  const option = getVoiceModelOption(models ?? [], tts.model);
  if (option?.costModelKey) {
    return option.costModelKey;
  }
  if (tts.provider === 'minimax') {
    return tts.model === 'speech-2.8-hd' ? 'minimax-speech-2.8-hd' : 'minimax-speech-2.8-turbo';
  }
  return option?.id ?? tts.model;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
