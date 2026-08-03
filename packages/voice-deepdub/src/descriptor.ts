import type { TTSProviderCatalogEntry, VoiceModelOption } from '@plumbus/voice/provider-kit';

export const DEEPDUB_TTS_MODELS: readonly VoiceModelOption[] = [
  {
    id: 'dd-etts-3.2',
    displayName: 'Deepdub eTTS 3.2',
    streaming: true,
    costModelKey: 'deepdub-phantom-x',
    recommended: 'live',
  },
  {
    id: 'dd-etts-3.0',
    displayName: 'Deepdub eTTS 3.0',
    streaming: true,
    costModelKey: 'deepdub-phantom-x',
  },
];

export const DEEPDUB_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
  id: 'deepdub',
  kind: 'tts',
  displayName: 'Deepdub',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  toneSupport: 'full',
  deliveryAxes: ['pace', 'warmth', 'energy', 'emotion'],
  deliveryMode: 'native-params',
  hebrewQuality: 'strong',
  knownModels: [...DEEPDUB_TTS_MODELS],
  voicesSource: 'live-api',
};
