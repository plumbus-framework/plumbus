import type { TTSProviderCatalogEntry, VoiceModelOption } from '@plumbus/voice/provider-kit';

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

export const MINIMAX_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
  id: 'minimax',
  kind: 'tts',
  displayName: 'MiniMax',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  toneSupport: 'full',
  deliveryAxes: ['pace', 'warmth', 'energy', 'emotion'],
  deliveryMode: 'native-params',
  languageBoost: true,
  hebrewQuality: 'good',
  knownModels: [...MINIMAX_TTS_MODELS],
  voicesSource: 'live-api',
};
