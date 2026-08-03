import type { ContextDependencies } from '@plumbus/core';
import type { VoiceProviderRegistry } from '@plumbus/voice';
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
  createDependencies: (auth: {
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
}

export interface VoiceAgentWorkerHandle {
  started: boolean;
  stop(): Promise<void>;
}
