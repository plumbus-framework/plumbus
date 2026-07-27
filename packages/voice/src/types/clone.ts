/**
 * Persisted voice-cloning contracts for TTS add-ons (DeepDub, Soniox).
 * Instant DeepDub `voiceReference` synthesis is a separate preview helper.
 */

export interface VoiceCloneCapabilities {
  supported: true;
  readiness: 'immediate' | 'async-per-model';
  supportsPersistedCreate: true;
  /** DeepDub HTTP voiceReference; Soniox false. */
  supportsInstantReference: boolean;
  maxSampleBytes: number;
  maxSampleSeconds?: number;
  requiresGender: boolean;
  requiresLocale: boolean;
  supportsRecompute: boolean;
  supportsDelete: true;
  /** Vendor account list — programmatic only; HTTP list uses listOwnedClones. */
  supportsList: true;
  supportsGet: true;
}

export type ClonedVoiceReadyState = 'ready' | 'processing' | 'failed' | 'not_computed';

export interface ClonedVoiceModelStatus {
  model: string;
  status: ClonedVoiceReadyState;
  errorType?: string;
  errorMessage?: string;
}

export interface ClonedVoice {
  id: string;
  providerId: string;
  displayName: string;
  locale?: string;
  createdAt?: string;
  status: ClonedVoiceReadyState;
  models?: ClonedVoiceModelStatus[];
}

export interface CreateClonedVoiceInput {
  name: string;
  audio: Uint8Array | Buffer;
  filename: string;
  mimeType?: string;
  locale?: string;
  /** Required for DeepDub persisted create. */
  gender?: 'male' | 'female';
  speakingStyle?: string;
  age?: number;
  /** Soniox readiness target model. */
  model?: string;
  signal?: AbortSignal;
}

export interface ListClonedVoicesInput {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ListClonedVoicesResult {
  voices: ClonedVoice[];
  nextCursor?: string;
}

export interface WaitClonedVoiceReadyInput {
  model?: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface RecomputeClonedVoiceInput {
  model?: string;
  signal?: AbortSignal;
}

export interface VoiceCloneProvider {
  readonly providerId: string;
  readonly capabilities: VoiceCloneCapabilities;
  create(input: CreateClonedVoiceInput): Promise<ClonedVoice>;
  get(id: string, signal?: AbortSignal): Promise<ClonedVoice | null>;
  list(input?: ListClonedVoicesInput): Promise<ListClonedVoicesResult>;
  delete(id: string, signal?: AbortSignal): Promise<void>;
  recompute?(id: string, input?: RecomputeClonedVoiceInput): Promise<ClonedVoice>;
  waitUntilReady(id: string, input?: WaitClonedVoiceReadyInput): Promise<ClonedVoice>;
}

/** DeepDub preview only — short text, full buffer in memory. */
export interface SynthesizeWithVoiceReferenceInput {
  text: string;
  audio: Uint8Array | Buffer;
  filename?: string;
  locale?: string;
  model?: string;
  sampleRate?: number;
  signal?: AbortSignal;
}
