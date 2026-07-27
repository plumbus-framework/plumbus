import { listVoiceProviderCatalog } from '../catalog/list-catalog.js';
import { registerVoicePricing } from '../cost/voice-pricing.js';
import type {
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
  ValidateVoiceProvidersInput,
  ValidateVoiceProvidersResult,
  VoiceProviderCredentials,
  VoiceProviderValidationIssue,
} from '../types/provider.js';
import type {
  STTProviderCapabilities,
  TransportProviderCapabilities,
} from './base/capabilities.js';
import type {
  STTProviderRegistration,
  TransportProviderRegistration,
  TTSProviderRegistration,
} from './base/provider-registration.js';
import type { STTProvider } from './base/stt-provider.js';
import type { TransportProvider } from './base/transport-provider.js';
import type { TTSProvider } from './base/tts-provider.js';
import { WEB_SPEECH_STT_REGISTRATION } from './stt/web-speech-stt.js';
import { WEBSOCKET_TRANSPORT_REGISTRATION } from './transport/websocket-transport.js';
import { BROWSER_TTS_REGISTRATION } from './tts/browser-tts.js';

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
    stt.set('web-speech', WEB_SPEECH_STT_REGISTRATION);
    tts.set('browser-tts', BROWSER_TTS_REGISTRATION);
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

  // Seed ledger pricing from every registered add-on (and builtins if they declare any).
  for (const registration of [...stt.values(), ...tts.values(), ...transport.values()]) {
    if (registration.pricing) {
      registerVoicePricing(registration.pricing);
    }
  }

  return { stt, tts, transport };
}

export function validateVoiceProviders(
  input: ValidateVoiceProvidersInput,
): ValidateVoiceProvidersResult {
  const catalog = input.catalog ?? listVoiceProviderCatalog(input.registry);
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
      input.registry?.transport,
    );
    validateProviderRef(
      voice.name,
      'stt',
      voice.stt.provider,
      sttById.get(voice.stt.provider),
      input.providers.providers[voice.stt.provider],
      issues,
      input.registry?.stt,
    );
    validateProviderRef(
      voice.name,
      'tts',
      voice.tts.provider,
      ttsById.get(voice.tts.provider),
      input.providers.providers[voice.tts.provider],
      issues,
      input.registry?.tts,
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
  registeredProviders?: ReadonlyMap<string, unknown>,
): void {
  if (!descriptor) {
    issues.push({
      voiceName,
      kind,
      provider: providerId,
      field: 'provider',
      message: `Unknown ${kind} provider "${providerId}" — install the add-on and pass its *_REGISTRATION to createProviderRegistry()`,
    });
    return;
  }

  if (registeredProviders && !registeredProviders.has(providerId)) {
    issues.push({
      voiceName,
      kind,
      provider: providerId,
      field: 'package',
      message: `Provider "${providerId}" is not registered — pass its *_REGISTRATION to createProviderRegistry()`,
    });
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
    descriptor: {
      id: providerId,
      kind: 'transport',
      displayName: providerId,
      credentialSchema: [],
      realtime: true,
      modes: [],
    },
    create() {
      return provider;
    },
  };
}
