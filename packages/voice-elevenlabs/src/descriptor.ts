import {
  getVoiceModelOption,
  type TTSProviderCatalogEntry,
  type VoiceModelOption,
} from '@plumbus/voice/provider-kit';

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
    streaming: true,
    costModelKey: 'eleven_v3',
    recommended: 'eval',
  },
];

/** Default when `tts.model` is unset — always `ELEVENLABS_TTS_MODELS[0]`. */
export const DEFAULT_ELEVENLABS_TTS_MODEL_ID = ELEVENLABS_TTS_MODELS[0]?.id ?? 'eleven_flash_v2_5';

export function createElevenLabsCapabilities(modelId?: string): TTSProviderCatalogEntry {
  const resolvedModel =
    getVoiceModelOption(ELEVENLABS_TTS_MODELS, modelId)?.id ?? DEFAULT_ELEVENLABS_TTS_MODEL_ID;
  const isV3 = resolvedModel === 'eleven_v3';

  return {
    id: 'elevenlabs',
    kind: 'tts',
    displayName: 'ElevenLabs',
    credentialSchema: [{ field: 'apiKey', required: true }],
    hosting: 'cloud',
    execution: 'server',
    streaming: true,
    toneSupport: isV3 ? 'partial' : 'partial',
    deliveryAxes: ['pace', 'warmth', 'energy', 'emotion'],
    deliveryMode: isV3 ? 'inline-text-tags' : 'native-params',
    hebrewQuality: isV3 ? 'good' : 'limited',
    knownModels: [...ELEVENLABS_TTS_MODELS],
    voicesSource: 'live-api',
  };
}

export const ELEVENLABS_TTS_DESCRIPTOR: TTSProviderCatalogEntry = createElevenLabsCapabilities();
