import { createProviderRegistry, type STTProvider, type TTSProvider } from '@plumbus/voice';
import type {
  STTProviderCatalogEntry,
  STTProviderRegistration,
  TransportProviderRegistration,
  TTSProviderCatalogEntry,
  TTSProviderRegistration,
} from '@plumbus/voice/provider-kit';
import { LIVEKIT_TRANSPORT_DESCRIPTOR } from '../../descriptor.js';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '../../transport/livekit-transport.js';

/** Minimal STT descriptor stub for agent tests (avoids cross-addon deps). */
const SONIOX_STT_DESCRIPTOR: STTProviderCatalogEntry = {
  id: 'soniox',
  kind: 'stt',
  displayName: 'Soniox',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  languages: 'multilingual',
  endpointDetection: true,
  knownModels: [],
};

/** Minimal TTS descriptor stub for agent tests (avoids cross-addon deps). */
const DEEPDUB_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
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
  knownModels: [],
  voicesSource: 'live-api',
};

function fakeSonioxRegistration(): STTProviderRegistration {
  const sttProvider: STTProvider = {
    capabilities: SONIOX_STT_DESCRIPTOR,
    connect() {},
    sendAudio() {},
    async finalize() {
      return { text: '', final: true };
    },
    usage() {
      return [];
    },
    disconnect() {},
  };

  return {
    descriptor: SONIOX_STT_DESCRIPTOR,
    create() {
      return sttProvider;
    },
    async listModels() {
      return [...SONIOX_STT_DESCRIPTOR.knownModels];
    },
  };
}

function fakeDeepdubRegistration(): TTSProviderRegistration {
  const ttsProvider: TTSProvider = {
    capabilities: DEEPDUB_TTS_DESCRIPTOR,
    mapDeliveryTone() {
      return {};
    },
    applyDeliveryToText(text: string) {
      return text;
    },
    async *synthesizeStream() {
      yield new Uint8Array([0, 0]);
    },
    usage() {
      return [];
    },
  };

  return {
    descriptor: DEEPDUB_TTS_DESCRIPTOR,
    create() {
      return ttsProvider;
    },
    async listModels() {
      return [...DEEPDUB_TTS_DESCRIPTOR.knownModels];
    },
  };
}

/** Explicit test registry with livekit + fake soniox/deepdub (no auto-load). */
export function createTestAgentRegistry(
  options: { includeCloud?: boolean; transport?: TransportProviderRegistration } = {},
): ReturnType<typeof createProviderRegistry> {
  const includeCloud = options.includeCloud !== false;
  return createProviderRegistry({
    transport: {
      livekit: options.transport ?? LIVEKIT_TRANSPORT_REGISTRATION,
    },
    stt: includeCloud ? { soniox: fakeSonioxRegistration() } : {},
    tts: includeCloud ? { deepdub: fakeDeepdubRegistration() } : {},
  });
}

export function livekitOnlyDescriptorId(): string {
  return LIVEKIT_TRANSPORT_DESCRIPTOR.id;
}
