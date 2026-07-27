import type { STTProviderCatalogEntry, VoiceModelOption } from '@plumbus/voice/provider-kit';

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
