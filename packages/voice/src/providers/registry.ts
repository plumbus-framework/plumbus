import type {
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
  ValidateVoiceProvidersInput,
  ValidateVoiceProvidersResult,
  VoiceProviderCredentials,
  VoiceProviderValidationIssue,
} from '../types/provider.js';
import { listVoiceProviderCatalog } from '../catalog/list-catalog.js';
import type {
  STTProviderCapabilities,
  TransportProviderCapabilities,
} from './base/capabilities.js';
import type {
  STTProviderRegistration,
  TTSProviderRegistration,
  TransportProviderRegistration,
} from './base/provider-registration.js';
import type { STTProvider } from './base/stt-provider.js';
import type { TTSProvider } from './base/tts-provider.js';
import type { TransportProvider } from './base/transport-provider.js';
import { SONIOX_STT_REGISTRATION } from './stt/soniox-stt.js';
import { OPENAI_WHISPER_STT_REGISTRATION } from './stt/openai-whisper-stt.js';
import { OPENAI_REALTIME_STT_REGISTRATION } from './stt/openai-realtime-stt.js';
import { WEB_SPEECH_STT_REGISTRATION } from './stt/web-speech-stt.js';
import { DEEPDUB_TTS_REGISTRATION } from './tts/deepdub-tts.js';
import { OPENAI_TTS_REGISTRATION } from './tts/openai-tts.js';
import { MINIMAX_TTS_REGISTRATION } from './tts/minimax-tts.js';
import { ELEVENLABS_TTS_REGISTRATION } from './tts/elevenlabs-tts.js';
import { BROWSER_TTS_REGISTRATION } from './tts/browser-tts.js';
import { LIVEKIT_TRANSPORT_REGISTRATION } from './transport/livekit-transport.js';
import { WEBSOCKET_TRANSPORT_REGISTRATION } from './transport/websocket-transport.js';

export interface CreateProviderRegistryOptions {
  includeBuiltins?: boolean;
  stt?: Record<string, STTProviderRegistration | STTProvider>;
  tts?: Record<string, TTSProviderRegistration | TTSProvider>;
  transport?: Record<string, TransportProviderRegistration | TransportProvider>;
}

export interface VoiceProviderRegistry {
  stt: ReadonlyMap<string, STTProviderRegistration>;
  tts: ReadonlyMap<string, TTSProviderRegistration>;
  transport: ReadonlyMap<string, TransportProviderRegistration>;
}

export function createProviderRegistry(
  options: CreateProviderRegistryOptions = {},
): VoiceProviderRegistry {
  const stt = new Map<string, STTProviderRegistration>();
  const tts = new Map<string, TTSProviderRegistration>();
  const transport = new Map<string, TransportProviderRegistration>();

  if (options.includeBuiltins !== false) {
    stt.set('soniox', SONIOX_STT_REGISTRATION);
    stt.set('openai-whisper', OPENAI_WHISPER_STT_REGISTRATION);
    stt.set('openai-realtime', OPENAI_REALTIME_STT_REGISTRATION);
    stt.set('web-speech', WEB_SPEECH_STT_REGISTRATION);

    tts.set('deepdub', DEEPDUB_TTS_REGISTRATION);
    tts.set('openai', OPENAI_TTS_REGISTRATION);
    tts.set('minimax', MINIMAX_TTS_REGISTRATION);
    tts.set('elevenlabs', ELEVENLABS_TTS_REGISTRATION);
    tts.set('browser-tts', BROWSER_TTS_REGISTRATION);

    transport.set('livekit', LIVEKIT_TRANSPORT_REGISTRATION);
    transport.set('websocket', WEBSOCKET_TRANSPORT_REGISTRATION);
  }

  for (const [providerId, provider] of Object.entries(options.stt ?? {})) {
    stt.set(providerId, normalizeSTTRegistration(providerId, provider));
  }
  for (const [providerId, provider] of Object.entries(options.tts ?? {})) {
    tts.set(providerId, normalizeTTSRegistration(providerId, provider));
  }
  for (const [providerId, provider] of Object.entries(options.transport ?? {})) {
    transport.set(providerId, normalizeTransportRegistration(providerId, provider));
  }

  return { stt, tts, transport };
}

export function validateVoiceProviders(
  input: ValidateVoiceProvidersInput,
): ValidateVoiceProvidersResult {
  const catalog = input.catalog ?? listVoiceProviderCatalog();
  const issues: VoiceProviderValidationIssue[] = [];
  const transportById = new Map(catalog.transport.map((provider) => [provider.id, provider]));
  const sttById = new Map(catalog.stt.map((provider) => [provider.id, provider]));
  const ttsById = new Map(catalog.tts.map((provider) => [provider.id, provider]));

  for (const voice of input.voices) {
    validateProviderRef(
      voice.name,
      'transport',
      voice.transport.provider,
      transportById.get(voice.transport.provider),
      input.providers.providers[voice.transport.provider],
      issues,
    );
    validateProviderRef(
      voice.name,
      'stt',
      voice.stt.provider,
      sttById.get(voice.stt.provider),
      input.providers.providers[voice.stt.provider],
      issues,
    );
    validateProviderRef(
      voice.name,
      'tts',
      voice.tts.provider,
      ttsById.get(voice.tts.provider),
      input.providers.providers[voice.tts.provider],
      issues,
    );
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

function validateProviderRef(
  voiceName: string,
  kind: 'transport' | 'stt' | 'tts',
  providerId: string,
  descriptor:
    | TransportProviderCapabilities
    | STTProviderCapabilities
    | TTSProviderCatalogEntry
    | undefined,
  credentials: VoiceProviderCredentials | undefined,
  issues: VoiceProviderValidationIssue[],
): void {
  if (!descriptor) {
    issues.push({
      voiceName,
      kind,
      provider: providerId,
      field: 'provider',
      message: `Unknown ${kind} provider "${providerId}"`,
    });
    return;
  }

  for (const field of descriptor.credentialSchema) {
    if (!field.required) continue;
    const value = credentials?.[field.field as keyof VoiceProviderCredentials];
    if (value === undefined || value === null || value === '') {
      issues.push({
        voiceName,
        kind,
        provider: providerId,
        field: field.field,
        message: `Missing required credential field "${field.field}" for ${providerId}`,
      });
    }
  }
}

function normalizeSTTRegistration(
  providerId: string,
  provider: STTProviderRegistration | STTProvider,
): STTProviderRegistration {
  if ('create' in provider) {
    return provider;
  }

  return {
    descriptor: {
      ...provider.capabilities,
      id: providerId,
      knownModels: [],
    } satisfies STTProviderCatalogEntry,
    create() {
      return provider;
    },
  };
}

function normalizeTTSRegistration(
  providerId: string,
  provider: TTSProviderRegistration | TTSProvider,
): TTSProviderRegistration {
  if ('create' in provider) {
    return provider;
  }

  return {
    descriptor: {
      ...provider.capabilities,
      id: providerId,
      knownModels: [],
      voicesSource: 'app-config',
    } satisfies TTSProviderCatalogEntry,
    create() {
      return provider;
    },
  };
}

function normalizeTransportRegistration(
  providerId: string,
  provider: TransportProviderRegistration | TransportProvider,
): TransportProviderRegistration {
  if ('create' in provider) {
    return provider;
  }

  return {
    descriptor: createFallbackTransportDescriptor(providerId),
    create() {
      return provider;
    },
  };
}

function createFallbackTransportDescriptor(providerId: string): TransportProviderCapabilities {
  return {
    id: providerId,
    kind: 'transport',
    displayName: providerId,
    credentialSchema: [],
    realtime: true,
    modes: [],
  };
}
