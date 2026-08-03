import type { VoiceModelOption } from '../types/provider.js';

export const WEB_SPEECH_STT_MODELS: readonly VoiceModelOption[] = [];

export const BROWSER_TTS_MODELS: readonly VoiceModelOption[] = [];

export function getVoiceModelOption(
  models: readonly VoiceModelOption[],
  modelId: string | undefined,
): VoiceModelOption | undefined {
  if (!modelId) {
    return models[0];
  }
  return models.find((model) => model.id === modelId);
}
