import type { TTSProviderCatalogEntry } from '../../types/provider.js';
import type { DeliveryTone, VoiceTtsConfig } from '../../types/voice.js';
import { BROWSER_TTS_MODELS } from '../../catalog/static-models.js';
import type { TTSProviderRegistration } from '../base/provider-registration.js';
import type { TTSProvider } from '../base/tts-provider.js';

const BROWSER_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
  id: 'browser-tts',
  kind: 'tts',
  displayName: 'Browser TTS',
  credentialSchema: [],
  hosting: 'browser',
  execution: 'client',
  streaming: false,
  toneSupport: 'none',
  deliveryAxes: [],
  deliveryMode: 'client-delegated',
  hebrewQuality: 'unknown',
  knownModels: [...BROWSER_TTS_MODELS],
  voicesSource: 'app-config',
};

class BrowserTTSProvider implements TTSProvider {
  readonly capabilities = BROWSER_TTS_DESCRIPTOR;
  #characters = 0;

  constructor(private readonly voiceSlice: VoiceTtsConfig) {}

  mapDeliveryTone(_tone: DeliveryTone) {
    return {
      voiceId: this.voiceSlice.voiceId,
      locale: this.voiceSlice.locale,
    };
  }

  usage() {
    if (this.#characters === 0) {
      return [];
    }

    return [
      {
        provider: this.capabilities.id,
        kind: 'other' as const,
        quantity: this.#characters,
        unit: 'characters' as const,
        metadata: { billable: false, execution: 'client' },
      },
    ];
  }
}

export const BROWSER_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: BROWSER_TTS_DESCRIPTOR,
  create(_credentials, voiceSlice) {
    return new BrowserTTSProvider(voiceSlice);
  },
};
