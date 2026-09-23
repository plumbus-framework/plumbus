import type { VoiceRecognitionContext } from '../../types/voice.js';
import type { VoiceUsageRecord } from '../../types/cost.js';
import type { STTProviderCapabilities } from './capabilities.js';

export interface STTProviderConnectArgs {
  sessionId: string;
  context?: VoiceRecognitionContext;
  signal?: VoiceAbortSignal;
  onTranscript?: (event: STTProviderTranscriptEvent) => Promise<void> | void;
  onEndpoint?: () => Promise<void> | void;
  /** Provider failure; callers can preserve partial text and offer reconnection. */
  onError?: (error: Error) => Promise<void> | void;
}

export interface STTProviderAudioChunk {
  chunk: Uint8Array;
  contentType?: string;
}

export interface STTProviderTranscriptEvent {
  text: string;
  final: boolean;
  language?: string;
  confidence?: number;
}

export interface VoiceAbortSignal {
  readonly aborted: boolean;
}

export interface STTProvider {
  readonly capabilities: STTProviderCapabilities;
  connect(args: STTProviderConnectArgs): Promise<void> | void;
  sendAudio?(audio: STTProviderAudioChunk): Promise<void> | void;
  onClientTranscript?(event: STTProviderTranscriptEvent): Promise<void> | void;
  finalize?():
    | Promise<STTProviderTranscriptEvent | undefined>
    | STTProviderTranscriptEvent
    | undefined;
  usage?(): VoiceUsageRecord[];
  disconnect?(): Promise<void> | void;
}
