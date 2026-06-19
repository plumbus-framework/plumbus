import type { VoiceModelOption, VoicePersonaOption } from '../types/provider.js';

export const SONIOX_STT_MODELS: readonly VoiceModelOption[] = [];

export const OPENAI_WHISPER_STT_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'whisper-1',
    displayName: 'Whisper 1',
    streaming: false,
    costModelKey: 'whisper-1',
    recommended: 'batch',
  },
  {
    id: 'gpt-4o-transcribe',
    displayName: 'GPT-4o Transcribe',
    streaming: false,
    costModelKey: 'gpt-4o-transcribe',
    recommended: 'batch',
  },
];

export const OPENAI_REALTIME_STT_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'gpt-realtime-whisper',
    displayName: 'GPT Realtime Whisper',
    streaming: true,
    costModelKey: 'gpt-realtime-whisper',
    recommended: 'live',
  },
];

export const WEB_SPEECH_STT_MODELS: readonly VoiceModelOption[] = [];

export const DEEPDUB_TTS_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'dd-etts-3.0',
    displayName: 'Deepdub eTTS 3.0',
    streaming: true,
    costModelKey: 'deepdub-phantom-x',
    recommended: 'live',
  },
  {
    id: 'dd-etts-3.2',
    displayName: 'Deepdub eTTS 3.2',
    streaming: true,
    costModelKey: 'deepdub-phantom-x',
  },
];

export const OPENAI_TTS_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'tts-1',
    displayName: 'tts-1',
    streaming: true,
    costModelKey: 'tts-1',
    recommended: 'live',
  },
  {
    id: 'tts-1-hd',
    displayName: 'tts-1-hd',
    streaming: true,
    costModelKey: 'tts-1-hd',
    recommended: 'eval',
  },
];

export const OPENAI_TTS_VOICES: readonly VoicePersonaOption[] = [
  { id: 'alloy', displayName: 'Alloy', locale: 'en-US' },
  { id: 'echo', displayName: 'Echo', locale: 'en-US' },
  { id: 'fable', displayName: 'Fable', locale: 'en-US' },
  { id: 'onyx', displayName: 'Onyx', locale: 'en-US' },
  { id: 'nova', displayName: 'Nova', locale: 'en-US' },
  { id: 'shimmer', displayName: 'Shimmer', locale: 'en-US' },
];

export const MINIMAX_TTS_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'speech-2.8-turbo',
    displayName: 'speech-2.8-turbo',
    streaming: true,
    costModelKey: 'minimax-speech-2.8-turbo',
    recommended: 'live',
  },
  {
    id: 'speech-2.8-hd',
    displayName: 'speech-2.8-hd',
    streaming: true,
    costModelKey: 'minimax-speech-2.8-hd',
    recommended: 'eval',
  },
];

export const ELEVENLABS_TTS_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'eleven_flash_v2_5',
    displayName: 'Eleven Flash v2.5',
    streaming: true,
    costModelKey: 'eleven_flash_v2_5',
    recommended: 'live',
  },
  {
    id: 'eleven_v3',
    displayName: 'Eleven v3',
    streaming: false,
    costModelKey: 'eleven_v3',
    recommended: 'eval',
  },
];

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
