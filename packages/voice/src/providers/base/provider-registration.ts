import type {
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
  VoiceModelOption,
  VoicePersonaOption,
  VoiceProviderCredentials,
} from '../../types/provider.js';
import type { VoiceSttConfig, VoiceTransportConfig, VoiceTtsConfig } from '../../types/voice.js';
import type { STTProvider } from './stt-provider.js';
import type { TransportProvider } from './transport-provider.js';
import type { TTSProvider } from './tts-provider.js';
import type { TransportProviderCapabilities } from './capabilities.js';

export interface VoiceCatalogFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type VoiceCatalogFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
  },
) => Promise<VoiceCatalogFetchResponse>;

export interface VoiceProviderListContext {
  fetcher?: VoiceCatalogFetch;
}

export interface STTProviderRegistration {
  descriptor: STTProviderCatalogEntry;
  create(credentials: VoiceProviderCredentials, voiceSlice: VoiceSttConfig): STTProvider;
  listModels?(
    credentials: VoiceProviderCredentials,
    context: VoiceProviderListContext,
  ): Promise<VoiceModelOption[]>;
}

export interface TTSProviderRegistration {
  descriptor: TTSProviderCatalogEntry;
  create(credentials: VoiceProviderCredentials, voiceSlice: VoiceTtsConfig): TTSProvider;
  listModels?(
    credentials: VoiceProviderCredentials,
    context: VoiceProviderListContext,
  ): Promise<VoiceModelOption[]>;
  listVoices?(
    credentials: VoiceProviderCredentials,
    modelId: string | undefined,
    context: VoiceProviderListContext,
  ): Promise<VoicePersonaOption[]>;
}

export interface TransportProviderRegistration {
  descriptor: TransportProviderCapabilities;
  create(
    credentials: VoiceProviderCredentials,
    voiceSlice: VoiceTransportConfig,
  ): TransportProvider;
}
