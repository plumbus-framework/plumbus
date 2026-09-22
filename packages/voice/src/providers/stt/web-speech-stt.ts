import type { STTProviderCatalogEntry } from '../../types/provider.js';
import { WEB_SPEECH_STT_MODELS } from '../../catalog/static-models.js';
import type { STTProviderRegistration } from '../base/provider-registration.js';
import type {
  STTProvider,
  STTProviderConnectArgs,
  STTProviderTranscriptEvent,
} from '../base/stt-provider.js';

const WEB_SPEECH_STT_DESCRIPTOR: STTProviderCatalogEntry = {
  id: 'web-speech',
  kind: 'stt',
  displayName: 'Web Speech',
  credentialSchema: [],
  hosting: 'browser',
  execution: 'client',
  streaming: true,
  languages: 'multilingual',
  knownModels: [...WEB_SPEECH_STT_MODELS],
};

class WebSpeechSTTProvider implements STTProvider {
  readonly capabilities = WEB_SPEECH_STT_DESCRIPTOR;
  #connectArgs: STTProviderConnectArgs | undefined;
  #lastFinalTranscript: STTProviderTranscriptEvent | undefined;

  connect(args: STTProviderConnectArgs): void {
    this.#connectArgs = args;
  }

  async onClientTranscript(event: STTProviderTranscriptEvent): Promise<void> {
    if (event.final) {
      this.#lastFinalTranscript = event;
    }
    await this.#connectArgs?.onTranscript?.(event);
  }

  finalize(): STTProviderTranscriptEvent | undefined {
    return this.#lastFinalTranscript;
  }

  usage() {
    return [];
  }
}

export const WEB_SPEECH_STT_REGISTRATION: STTProviderRegistration = {
  descriptor: WEB_SPEECH_STT_DESCRIPTOR,
  create() {
    return new WebSpeechSTTProvider();
  },
};
