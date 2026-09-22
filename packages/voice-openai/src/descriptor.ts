import type {
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
  VoiceModelOption,
  VoicePersonaOption,
} from '@plumbus/voice/provider-kit';

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

export const OPENAI_WHISPER_STT_DESCRIPTOR: STTProviderCatalogEntry = {
  id: 'openai-whisper',
  kind: 'stt',
  displayName: 'OpenAI Whisper',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: false,
  languages: 'multilingual',
  knownModels: [...OPENAI_WHISPER_STT_MODELS],
};

export const OPENAI_REALTIME_STT_DESCRIPTOR: STTProviderCatalogEntry = {
  id: 'openai-realtime',
  kind: 'stt',
  displayName: 'OpenAI Realtime',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  languages: 'multilingual',
  knownModels: [...OPENAI_REALTIME_STT_MODELS],
};

export const OPENAI_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
  id: 'openai',
  kind: 'tts',
  displayName: 'OpenAI TTS',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  toneSupport: 'pace-only',
  deliveryAxes: ['pace'],
  deliveryMode: 'native-params',
  hebrewQuality: 'limited',
  knownModels: [...OPENAI_TTS_MODELS],
  knownVoices: [...OPENAI_TTS_VOICES],
  voicesSource: 'static',
};
