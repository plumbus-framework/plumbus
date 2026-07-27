import type {
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
  VoiceModelOption,
  VoicePersonaOption,
} from '@plumbus/voice/provider-kit';

export const SONIOX_STT_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'stt-rt-v5',
    displayName: 'Soniox STT RT v5',
    streaming: true,
    costModelKey: 'soniox-stt',
    recommended: 'live',
  },
  {
    id: 'stt-rt-v1',
    displayName: 'Soniox STT RT v1',
    streaming: true,
    costModelKey: 'soniox-stt',
  },
  {
    id: 'stt-rt-preview',
    displayName: 'Soniox STT RT Preview',
    streaming: true,
    costModelKey: 'soniox-stt',
  },
];

export const SONIOX_TTS_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'tts-rt-v1',
    displayName: 'Soniox TTS RT v1',
    streaming: true,
    costModelKey: 'soniox-tts',
    recommended: 'live',
  },
];

/** Built-in Soniox TTS voices (multilingual). Live catalog via `listVoices` when available. */
export const SONIOX_TTS_VOICES: readonly VoicePersonaOption[] = [
  { id: 'Maya', displayName: 'Maya' },
  { id: 'Daniel', displayName: 'Daniel' },
  { id: 'Noah', displayName: 'Noah' },
  { id: 'Nina', displayName: 'Nina' },
  { id: 'Emma', displayName: 'Emma' },
  { id: 'Jack', displayName: 'Jack' },
  { id: 'Adrian', displayName: 'Adrian' },
  { id: 'Claire', displayName: 'Claire' },
  { id: 'Grace', displayName: 'Grace' },
  { id: 'Owen', displayName: 'Owen' },
  { id: 'Mina', displayName: 'Mina' },
  { id: 'Kenji', displayName: 'Kenji' },
  { id: 'Rafael', displayName: 'Rafael' },
  { id: 'Mateo', displayName: 'Mateo' },
  { id: 'Lucia', displayName: 'Lucia' },
  { id: 'Sofia', displayName: 'Sofia' },
  { id: 'Oliver', displayName: 'Oliver' },
  { id: 'Arthur', displayName: 'Arthur' },
  { id: 'Isla', displayName: 'Isla' },
  { id: 'Victoria', displayName: 'Victoria' },
  { id: 'Cooper', displayName: 'Cooper' },
  { id: 'Mason', displayName: 'Mason' },
  { id: 'Ruby', displayName: 'Ruby' },
  { id: 'Elise', displayName: 'Elise' },
  { id: 'Arjun', displayName: 'Arjun' },
  { id: 'Rohan', displayName: 'Rohan' },
  { id: 'Priya', displayName: 'Priya' },
  { id: 'Meera', displayName: 'Meera' },
];

export const SONIOX_STT_DESCRIPTOR: STTProviderCatalogEntry = {
  id: 'soniox',
  kind: 'stt',
  displayName: 'Soniox',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  languages: 'multilingual',
  endpointDetection: true,
  knownModels: [...SONIOX_STT_MODELS],
};

export const SONIOX_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
  id: 'soniox',
  kind: 'tts',
  displayName: 'Soniox TTS',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  toneSupport: 'none',
  deliveryAxes: [],
  deliveryMode: 'native-params',
  hebrewQuality: 'good',
  knownModels: [...SONIOX_TTS_MODELS],
  knownVoices: [...SONIOX_TTS_VOICES],
  voicesSource: 'live-api',
};
