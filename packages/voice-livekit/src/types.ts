import type { ContextDependencies } from '@plumbus/core';
import type { VoiceProviderRegistry } from '@plumbus/voice/session';
import type {
  TransportProvider,
  VoiceDefinition,
  VoiceProvidersConfig,
  VoiceSessionBudgetConfig,
} from '@plumbus/voice/provider-kit';

/** Session metadata returned by LiveKit `mintSession`. */
export interface LiveKitSessionMetadata {
  url: string;
  room: string;
  token: string;
  identity: string;
  audioFormat: string;
  audioTrackName: string;
  mode: string;
}

export interface ConnectLiveKitWorkerArgs {
  voiceName: string;
  room?: string;
  identity?: string;
  token?: string;
  participantName?: string;
  metadata?: string;
  attributes?: Record<string, string>;
  audioTrackName?: string;
  agentAudioTrackName?: string;
  dataTopic?: string;
  signal?: AbortSignal;
  onAudio?: (audio: Uint8Array) => Promise<void> | void;
  onData?: (payload: unknown) => Promise<void> | void;
}

/** Opaque room handle — concrete LiveKit `Room` stays in the transport impl. */
export interface LiveKitWorkerRoom {
  disconnect(): Promise<void>;
}

export interface LiveKitWorkerConnection {
  room: LiveKitWorkerRoom;
  disconnect(): Promise<void>;
}

export interface LiveKitTransportProvider extends TransportProvider {
  connectWorker(args: ConnectLiveKitWorkerArgs): Promise<LiveKitWorkerConnection>;
  publishAudio(audio: Uint8Array): Promise<void>;
  sendData(payload: unknown): Promise<void>;
}

export interface MintLiveKitParticipantTokenArgs {
  apiKey: string;
  apiSecret: string;
  room: string;
  identity: string;
  participantName?: string;
  ttlSeconds?: number;
  metadata?: string;
  attributes?: Record<string, string>;
  agentName?: string;
  agentMetadata?: string;
}

export interface StartVoiceAgentWorkerOptions {
  voices: VoiceDefinition[];
  providers: VoiceProvidersConfig;
  /** Optional for a dispatch-only parent when bootstrapModule supplies child dependencies. */
  createDependencies?: (auth: {
    userId: string;
    tenantId?: string;
    roles: string[];
    scopes: string[];
    provider: string;
  }) => ContextDependencies;
  signal?: AbortSignal;
  registry?: VoiceProviderRegistry;
  sessionBudget?: VoiceSessionBudgetConfig;
  agentName?: string;
  wsURL?: string;
  apiKey?: string;
  apiSecret?: string;
  bootstrapModule?: string;
  /** Job processes kept started and prewarmed ahead of calls (env PLUMBUS_VOICE_IDLE_PROCESSES; SDK default otherwise). */
  numIdleProcesses?: number;
  /** Time a job process may take to start and prewarm (env PLUMBUS_VOICE_PROCESS_INIT_TIMEOUT_MS; default 30000). */
  initializeProcessTimeoutMs?: number;
}

export interface VoiceAgentWorkerHandle {
  started: boolean;
  stop(): Promise<void>;
}
