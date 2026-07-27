import type { VoicePricingEntry } from '../../cost/voice-pricing.js';
import type {
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
  VoiceModelOption,
  VoicePersonaOption,
  VoiceProviderCredentials,
} from '../../types/provider.js';
import type { VoiceSttConfig, VoiceTransportConfig, VoiceTtsConfig } from '../../types/voice.js';
import type { TransportProviderCapabilities } from './capabilities.js';
import type { STTProvider } from './stt-provider.js';
import type { TransportProvider, TransportProviderSession } from './transport-provider.js';
import type { TTSProvider } from './tts-provider.js';

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
    body?: string;
  },
) => Promise<VoiceCatalogFetchResponse>;

export interface VoiceProviderListContext {
  fetcher?: VoiceCatalogFetch;
}

export interface STTProviderRegistration {
  descriptor: STTProviderCatalogEntry;
  create(credentials: VoiceProviderCredentials, voiceSlice: VoiceSttConfig): STTProvider;
  /** Ledger pricing rows — registered into `lookupVoicePricing` by `createProviderRegistry()`. */
  pricing?: VoicePricingEntry | readonly VoicePricingEntry[];
  listModels?(
    credentials: VoiceProviderCredentials,
    context: VoiceProviderListContext,
  ): Promise<VoiceModelOption[]>;
}

export interface TTSProviderRegistration {
  descriptor: TTSProviderCatalogEntry;
  create(credentials: VoiceProviderCredentials, voiceSlice: VoiceTtsConfig): TTSProvider;
  /** Ledger pricing rows — registered into `lookupVoicePricing` by `createProviderRegistry()`. */
  pricing?: VoicePricingEntry | readonly VoicePricingEntry[];
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
  /** Ledger pricing rows — registered into `lookupVoicePricing` by `createProviderRegistry()`. */
  pricing?: VoicePricingEntry | readonly VoicePricingEntry[];
  /**
   * Maps a minted transport session into the JSON body for `POST /api/voice/:name/token`.
   * Required for room transports that serve `/token`.
   */
  toClientSessionPayload?(
    session: TransportProviderSession,
    context: { voiceName: string; transportProviderId: string },
  ): Record<string, unknown>;
}
