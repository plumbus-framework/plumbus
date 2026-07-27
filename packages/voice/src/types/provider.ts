import type {
  STTProviderCapabilities,
  TTSProviderCapabilities,
  TransportProviderCapabilities,
} from '../providers/base/capabilities.js';
import type { VoiceDefinition } from './voice.js';

export interface VoiceProviderCredentials {
  apiKey?: string;
  apiSecret?: string;
  url?: string;
  baseUrl?: string;
  options?: Record<string, unknown>;
}

export interface VoiceProvidersConfig {
  providers: Record<string, VoiceProviderCredentials>;
}

export type VoiceCatalogSource = 'static' | 'live-api' | 'app-config';
export type VoiceCatalogRecommendation = 'live' | 'batch' | 'eval';
export type VoiceProviderKind = 'transport' | 'stt' | 'tts';

export interface VoiceModelOption {
  id: string;
  displayName: string;
  streaming: boolean;
  costModelKey?: string;
  recommended?: VoiceCatalogRecommendation;
}

export interface VoicePersonaOption {
  id: string;
  displayName: string;
  locale?: string;
  previewUrl?: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
}

export interface STTProviderCatalogEntry extends STTProviderCapabilities {
  knownModels: VoiceModelOption[];
}

export interface TTSProviderCatalogEntry extends TTSProviderCapabilities {
  knownModels: VoiceModelOption[];
  knownVoices?: VoicePersonaOption[];
  voicesSource?: VoiceCatalogSource;
}

export interface VoiceProviderCatalog {
  transport: TransportProviderCapabilities[];
  stt: STTProviderCatalogEntry[];
  tts: TTSProviderCatalogEntry[];
}

export interface VoiceProviderOptionsResult {
  providerId: string;
  kind: 'stt' | 'tts';
  models: VoiceModelOption[];
  voices: VoicePersonaOption[];
  source: VoiceCatalogSource;
  partial: boolean;
  cached?: boolean;
  error?: string;
}

export interface VoiceStackSuggestion {
  id: string;
  transport: string;
  stt: string;
  tts: string;
  useCase: string;
}

export interface VoiceProviderValidationIssue {
  voiceName: string;
  kind: 'transport' | 'stt' | 'tts';
  provider: string;
  field: string;
  message: string;
}

export interface ValidateVoiceProvidersInput {
  voices: VoiceDefinition[];
  providers: VoiceProvidersConfig;
  catalog?: VoiceProviderCatalog;
  /** When set, flags catalog providers that require an unloaded add-on package. */
  registry?: import('../providers/registry.js').VoiceProviderRegistry;
}

export interface ValidateVoiceProvidersResult {
  ok: boolean;
  issues: VoiceProviderValidationIssue[];
}
