import type { VoiceUsageRecord } from '../types/cost.js';
import type { DeliveryTone } from '../types/voice.js';
import type { STTProvider } from '../providers/base/stt-provider.js';
import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { TransportProvider } from '../providers/base/transport-provider.js';

export function createMockSTTProvider(overrides: Partial<STTProvider> = {}): STTProvider {
  return {
    capabilities: {
      id: 'mock-stt',
      kind: 'stt',
      displayName: 'Mock STT',
      credentialSchema: [],
      execution: 'server',
      streaming: true,
      languages: 'multilingual',
    },
    connect() {},
    sendAudio() {},
    usage() {
      return [] satisfies VoiceUsageRecord[];
    },
    ...overrides,
  };
}

export function createMockTTSProvider(overrides: Partial<TTSProvider> = {}): TTSProvider {
  return {
    capabilities: {
      id: 'mock-tts',
      kind: 'tts',
      displayName: 'Mock TTS',
      credentialSchema: [],
      execution: 'server',
      streaming: true,
      toneSupport: 'full',
      deliveryAxes: ['pace', 'warmth', 'energy', 'emotion'],
      deliveryMode: 'native-params',
    },
    mapDeliveryTone(tone: DeliveryTone) {
      return { tone };
    },
    async *synthesizeStream() {
      yield new Uint8Array();
    },
    usage() {
      return [] satisfies VoiceUsageRecord[];
    },
    ...overrides,
  };
}

export function createMockTransportProvider(
  overrides: Partial<TransportProvider> = {},
): TransportProvider {
  return {
    async mintSession() {
      return { sessionId: 'mock-session', transport: 'mock' };
    },
    publishAudio() {},
    sendData() {},
    disconnect() {},
    ...overrides,
  };
}
