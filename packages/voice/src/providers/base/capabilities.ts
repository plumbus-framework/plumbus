export type STTExecutionSite = 'server' | 'client';
export type TTSExecutionSite = 'server' | 'client';
export type DeliveryAxis = 'pace' | 'warmth' | 'energy' | 'emotion';
export type ToneSupport = 'full' | 'partial' | 'pace-only' | 'none';
export type DeliveryMode = 'native-params' | 'inline-text-tags' | 'client-delegated' | 'none';

export interface ProviderCredentialField {
  field: string;
  required: boolean;
}

export interface ProviderDescriptor {
  id: string;
  kind: 'stt' | 'tts' | 'transport';
  displayName: string;
  credentialSchema: ProviderCredentialField[];
  hosting?: 'cloud' | 'browser' | 'self-hosted';
}

export interface STTProviderCapabilities extends ProviderDescriptor {
  kind: 'stt';
  execution: STTExecutionSite;
  streaming: boolean;
  languages: 'multilingual' | string[];
  /**
   * True when the provider emits a reliable end-of-speech signal (via
   * `onEndpoint`). The continuous-session controller then drives turns purely
   * from that signal and skips its silence-timer failsafe (unless an app
   * explicitly re-enables it with a positive `stt.options.endpointSilenceMs`).
   */
  endpointDetection?: boolean;
}

export interface TTSProviderCapabilities extends ProviderDescriptor {
  kind: 'tts';
  execution: TTSExecutionSite;
  streaming: boolean;
  toneSupport: ToneSupport;
  deliveryAxes: DeliveryAxis[];
  deliveryMode: DeliveryMode;
  languageBoost?: boolean;
  hebrewQuality?: 'strong' | 'good' | 'limited' | 'unknown';
}

export interface TransportProviderCapabilities extends ProviderDescriptor {
  kind: 'transport';
  realtime: boolean;
  modes: string[];
}
