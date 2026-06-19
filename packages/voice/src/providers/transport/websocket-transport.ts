import { randomUUID } from 'node:crypto';
import type { VoiceTransportConfig } from '../../types/voice.js';
import type { TransportProviderCapabilities } from '../base/capabilities.js';
import type { TransportProviderRegistration } from '../base/provider-registration.js';
import type { TransportProvider, TransportProviderSession } from '../base/transport-provider.js';

const DEFAULT_AUDIO_FORMAT = 'pcm16;rate=16000;channels=1';

export interface WebSocketTransportSessionMetadata {
  path: string;
  mode: string;
  audioFormat: string;
  events: 'same-socket';
}

export interface AttachWebSocketTransportArgs {
  socket: {
    on(event: 'message', listener: (raw: Buffer | string, isBinary: boolean) => void): void;
    on(event: 'close', listener: () => void): void;
    send(payload: string | Uint8Array, options?: { binary?: boolean }): void;
    close(code?: number, reason?: string): void;
  };
  onAudio?: (audio: Uint8Array) => Promise<void> | void;
  onControl?: (payload: Record<string, unknown>) => Promise<void> | void;
  onClose?: () => Promise<void> | void;
}

export const WEBSOCKET_TRANSPORT_DESCRIPTOR: TransportProviderCapabilities = {
  id: 'websocket',
  kind: 'transport',
  displayName: 'WebSocket',
  credentialSchema: [],
  hosting: 'self-hosted',
  realtime: true,
  modes: ['pushToTalk', 'continuous'],
};

export class WebSocketTransportProvider implements TransportProvider {
  private activeSocket?: AttachWebSocketTransportArgs['socket'];

  constructor(private readonly voiceSlice: VoiceTransportConfig) {}

  async mintSession(args: {
    voiceName: string;
    userId?: string;
  }): Promise<TransportProviderSession> {
    return {
      sessionId: `websocket:${args.voiceName}:${args.userId ?? 'anonymous'}:${randomUUID()}`,
      transport: 'websocket',
      metadata: {
        mode: this.voiceSlice.mode ?? 'pushToTalk',
        audioFormat: normalizeAudioFormat(this.voiceSlice.audioFormat),
        path: resolveWebSocketPath(this.voiceSlice),
        events: 'same-socket',
      } satisfies WebSocketTransportSessionMetadata,
    };
  }

  attachSocket(args: AttachWebSocketTransportArgs): void {
    this.activeSocket = args.socket;
    args.socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        const chunk =
          typeof raw === 'string'
            ? Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff)
            : new Uint8Array(raw);
        void args.onAudio?.(chunk);
        return;
      }

      const payload = decodeControlFrame(raw);
      if ('error' in payload) {
        void this.sendData({
          type: 'error',
          code: 'voice.invalid_message',
          message: payload.error,
        });
        return;
      }

      void args.onControl?.(payload.value);
    });

    args.socket.on('close', () => {
      this.activeSocket = undefined;
      void args.onClose?.();
    });
  }

  publishAudio(audio: Uint8Array): void {
    this.activeSocket?.send(audio, { binary: true });
  }

  sendData(payload: unknown): void {
    this.activeSocket?.send(JSON.stringify(payload));
  }

  disconnect(): void {
    this.activeSocket?.close();
    this.activeSocket = undefined;
  }
}

export const WEBSOCKET_TRANSPORT_REGISTRATION: TransportProviderRegistration = {
  descriptor: WEBSOCKET_TRANSPORT_DESCRIPTOR,
  create(_credentials, voiceSlice) {
    return new WebSocketTransportProvider(voiceSlice);
  },
};

function resolveWebSocketPath(voiceSlice: VoiceTransportConfig): string {
  const path = voiceSlice.options?.path;
  return typeof path === 'string' && path.length > 0 ? path : '/api/voice/:voiceName/stream';
}

function normalizeAudioFormat(audioFormat: string | undefined): string {
  if (!audioFormat) return DEFAULT_AUDIO_FORMAT;
  if (audioFormat === 'pcm16-16k') return DEFAULT_AUDIO_FORMAT;
  if (audioFormat === 'pcm16-24k') return 'pcm16;rate=24000;channels=1';
  return audioFormat;
}

function decodeControlFrame(
  raw: Buffer | string,
): { value: Record<string, unknown> } | { error: string } {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
    const value = JSON.parse(text) as Record<string, unknown>;
    return { value };
  } catch {
    return { error: 'Expected JSON control frame' };
  }
}
