import { getVoiceModelOption } from '../catalog/static-models.js';
import type { VoiceModelOption } from '../types/provider.js';
import type { VoiceDefinition, VoiceSttConfig, VoiceTtsConfig } from '../types/voice.js';
import { calculateVoiceCost } from './voice-pricing.js';

const DEFAULT_AUDIO_INPUT_SECONDS = 30;
const DEFAULT_RESPONSE_CHARACTERS = 200;

const FREE_STT_PROVIDERS = new Set(['web-speech', 'mock-stt']);
const FREE_TTS_PROVIDERS = new Set(['browser-tts', 'mock-tts']);

export interface EstimateVoiceTurnCostInput {
  voice: VoiceDefinition;
  estimatedAudioInputSeconds?: number;
  estimatedResponseCharacters?: number;
  /** knownModels from the provider registration (required for paid cloud providers). */
  sttModels?: readonly VoiceModelOption[];
  ttsModels?: readonly VoiceModelOption[];
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

  const sttModelKey = resolveSttCostModelKey(input.voice.stt, input.sttModels);
  const ttsModelKey = resolveTtsCostModelKey(input.voice.tts, input.ttsModels);

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

export function resolveSttCostModelKey(
  stt: VoiceSttConfig,
  models?: readonly VoiceModelOption[],
): string | undefined {
  if (FREE_STT_PROVIDERS.has(stt.provider)) {
    return undefined;
  }

  const option = getVoiceModelOption(models ?? [], stt.model);
  return option?.costModelKey ?? option?.id ?? stt.model;
}

export function resolveTtsCostModelKey(
  tts: VoiceTtsConfig,
  models?: readonly VoiceModelOption[],
): string | undefined {
  if (FREE_TTS_PROVIDERS.has(tts.provider)) {
    return undefined;
  }

  const option = getVoiceModelOption(models ?? [], tts.model);
  return option?.costModelKey ?? option?.id ?? tts.model;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
