import { randomUUID } from 'node:crypto';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import type { VoiceProviderCredentials } from '../../types/provider.js';
import type { VoiceTransportConfig } from '../../types/voice.js';
import type { TransportProviderCapabilities } from '../base/capabilities.js';
import type { TransportProviderRegistration } from '../base/provider-registration.js';
import type { TransportProvider, TransportProviderSession } from '../base/transport-provider.js';
import { consumeAudioStream } from '../../runtime/consume-audio-stream.js';

const DEFAULT_AUDIO_FORMAT = 'pcm16;rate=16000;channels=1';
const DEFAULT_DATA_TOPIC = 'voice.events';
const DEFAULT_SESSION_TTL_SECONDS = 3600;
const MAX_SESSION_TTL_SECONDS = 7200;
const DEFAULT_AGENT_AUDIO_TRACK_NAME = 'dvora-voice';
const DEFAULT_ROOM_USER = 'voiceUser';

export interface LiveKitSessionMetadata {
  url: string;
  room: string;
  token: string;
  identity: string;
  audioFormat: string;
  audioTrackName: string;
  mode: string;
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
}

export interface MintLiveKitSessionArgs {
  voiceName: string;
  userId?: string;
  sessionId?: string;
  roomName?: string;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, string>;
  tokenTtlSeconds?: number;
  identity?: string;
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

export interface LiveKitWorkerConnection {
  room: Room;
  disconnect(): Promise<void>;
}

export type LiveKitRoomResolver = (args: {
  voiceName: string;
  userId?: string;
  sessionId: string;
}) => string;

export const LIVEKIT_TRANSPORT_DESCRIPTOR: TransportProviderCapabilities = {
  id: 'livekit',
  kind: 'transport',
  displayName: 'LiveKit',
  credentialSchema: [
    { field: 'url', required: true },
    { field: 'apiKey', required: true },
    { field: 'apiSecret', required: true },
  ],
  hosting: 'cloud',
  realtime: true,
  modes: ['pushToTalk', 'continuous'],
};

export async function mintLiveKitParticipantToken(
  args: MintLiveKitParticipantTokenArgs,
): Promise<string> {
  const accessToken = new AccessToken(args.apiKey, args.apiSecret, {
    identity: args.identity,
    name: args.participantName ?? args.identity,
    ttl: clampTokenTtlSeconds(args.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS),
    metadata: args.metadata,
    attributes: sanitizeAttributes(args.attributes),
  });
  accessToken.addGrant({
    room: args.room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return accessToken.toJwt();
}

export class LiveKitTransportProvider implements TransportProvider {
  private activeConnection?: {
    room: Room;
    audioSource: AudioSource;
    localTrack: LocalAudioTrack;
    dataTopic: string;
    onAudio?: (audio: Uint8Array) => Promise<void> | void;
  };

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTransportConfig,
  ) {}

  async mintSession(args: MintLiveKitSessionArgs): Promise<TransportProviderSession> {
    const sessionId =
      args.sessionId ??
      `livekit:${args.voiceName}:${args.userId ?? 'anonymous'}:${randomUUID()}`;
    const metadata = await this.createSessionMetadata(args.voiceName, args.userId, {
      room: args.roomName,
      identity: args.identity,
      ttlSeconds: args.tokenTtlSeconds,
      metadata: serializeMetadata(args.metadata),
      attributes: args.attributes,
      sessionId,
    });
    return {
      sessionId,
      transport: 'livekit',
      metadata: metadata as unknown as Record<string, unknown>,
    };
  }

  async connectWorker(args: ConnectLiveKitWorkerArgs): Promise<LiveKitWorkerConnection> {
    if (args.signal?.aborted) {
      throw new Error('LiveKit worker connection aborted before connect');
    }

    const metadata = await this.createSessionMetadata(args.voiceName, args.identity, {
      room: args.room,
      identity: args.identity,
      audioTrackName: args.agentAudioTrackName ?? args.audioTrackName,
      ttlSeconds: resolveWorkerTokenTtlSeconds(this.voiceSlice.options),
      token: args.token,
      participantName: args.participantName,
      metadata: args.metadata,
      attributes: args.attributes,
    });

    const room = new Room();
    await room.connect(metadata.url, metadata.token);

    const audioSource = createAudioSource(metadata.audioFormat);
    const localTrack = LocalAudioTrack.createAudioTrack(metadata.audioTrackName, audioSource);
    const publishOptions = new TrackPublishOptions();
    await room.localParticipant?.publishTrack(localTrack, publishOptions);

    const activeConnection = {
      room,
      audioSource,
      localTrack,
      dataTopic: args.dataTopic ?? DEFAULT_DATA_TOPIC,
      onAudio: args.onAudio,
    };
    this.activeConnection = activeConnection;

    if (args.signal) {
      args.signal.addEventListener(
        'abort',
        () => {
          void this.disconnect();
        },
        { once: true },
      );
    }

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (!this.activeConnection) return;
      const isAudio =
        track.kind === TrackKind.KIND_AUDIO || (track.kind as number | undefined) === 1;
      if (!isAudio || !this.activeConnection.onAudio) return;
      void this.forwardRemoteAudio(track, this.activeConnection.onAudio);
    });

    room.on(RoomEvent.DataReceived, (payload) => {
      if (!args.onData) return;
      void args.onData(parseLiveKitDataPayload(payload));
    });

    return {
      room,
      disconnect: async () => {
        await this.disconnect();
      },
    };
  }

  async publishAudio(audio: Uint8Array): Promise<void> {
    const connection = this.activeConnection;
    if (!connection) return;

    const format = parsePcmFormat(this.voiceSlice.audioFormat);
    const audioFrame = new AudioFrame(
      pcmBytesToInt16(audio),
      format.sampleRate,
      format.channels,
      Math.max(1, audio.byteLength / (2 * format.channels)),
    );
    await connection.audioSource.captureFrame(audioFrame);
  }

  subscribeRemote(onAudio: (audio: Uint8Array) => Promise<void> | void): void {
    if (this.activeConnection) {
      this.activeConnection.onAudio = onAudio;
    }
  }

  async sendData(payload: unknown): Promise<void> {
    const connection = this.activeConnection;
    if (!connection?.room.localParticipant) return;

    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    await connection.room.localParticipant.publishData(encoded, {
      reliable: true,
      topic: connection.dataTopic,
    });
  }

  async disconnect(): Promise<void> {
    const connection = this.activeConnection;
    this.activeConnection = undefined;

    if (!connection) return;
    await connection.localTrack.close();
    await connection.audioSource.close();
    await connection.room.disconnect();
  }

  private async createSessionMetadata(
    voiceName: string,
    userId?: string,
    overrides: {
      room?: string;
      identity?: string;
      token?: string;
      ttlSeconds?: number;
      participantName?: string;
      metadata?: string;
      attributes?: Record<string, string>;
      audioTrackName?: string;
      sessionId?: string;
    } = {},
  ): Promise<LiveKitSessionMetadata> {
    const url = requireString(this.credentials.url, 'LiveKit url');
    const apiKey = requireString(this.credentials.apiKey, 'LiveKit apiKey');
    const apiSecret = requireString(this.credentials.apiSecret, 'LiveKit apiSecret');
    const sessionId =
      overrides.sessionId ?? `livekit:${voiceName}:${userId ?? 'anonymous'}:${randomUUID()}`;
    const room =
      overrides.room ?? resolveRoomName(this.voiceSlice, voiceName, userId, sessionId);
    const identity = overrides.identity ?? resolveIdentity(voiceName, userId);
    const audioFormat = normalizeAudioFormat(this.voiceSlice.audioFormat);
    const audioTrackName =
      overrides.audioTrackName ?? resolveAgentAudioTrackName(this.voiceSlice, voiceName, identity);

    let token = overrides.token;
    if (!token) {
      token = await mintLiveKitParticipantToken({
        apiKey,
        apiSecret,
        room,
        identity,
        participantName: overrides.participantName ?? identity,
        ttlSeconds: overrides.ttlSeconds ?? resolveLiveKitTokenTtlSeconds(this.voiceSlice.options),
        metadata: overrides.metadata,
        attributes: sanitizeAttributes(overrides.attributes),
      });
    }

    return {
      url,
      room,
      token,
      identity,
      audioFormat,
      audioTrackName,
      mode: this.voiceSlice.mode ?? 'pushToTalk',
    };
  }

  private async forwardRemoteAudio(
    track: RemoteTrack,
    onAudio: (audio: Uint8Array) => Promise<void> | void,
  ): Promise<void> {
    const stream = new AudioStream(track, parsePcmFormat(this.voiceSlice.audioFormat));
    await consumeAudioStream(stream, async (frame) => {
      await onAudio(int16ToBytes(frame.data));
    });
  }
}

export const LIVEKIT_TRANSPORT_REGISTRATION: TransportProviderRegistration = {
  descriptor: LIVEKIT_TRANSPORT_DESCRIPTOR,
  create(credentials, voiceSlice) {
    return new LiveKitTransportProvider(credentials, voiceSlice);
  },
};

function createAudioSource(audioFormat: string): AudioSource {
  const format = parsePcmFormat(audioFormat);
  return new AudioSource(format.sampleRate, format.channels);
}

function parsePcmFormat(audioFormat: string | undefined): {
  sampleRate: number;
  channels: number;
  frameSizeMs: number;
} {
  const normalized = normalizeAudioFormat(audioFormat);
  const rateMatch = normalized.match(/rate=(\d+)/);
  const channelsMatch = normalized.match(/channels=(\d+)/);
  const frameSizeMatch = normalized.match(/frame=(\d+)/);
  return {
    sampleRate: Number(rateMatch?.[1] ?? 16000),
    channels: Number(channelsMatch?.[1] ?? 1),
    frameSizeMs: Number(frameSizeMatch?.[1] ?? 20),
  };
}

function normalizeAudioFormat(audioFormat: string | undefined): string {
  if (!audioFormat) return DEFAULT_AUDIO_FORMAT;
  if (audioFormat.includes('rate=')) return audioFormat;

  const short = audioFormat.toLowerCase();
  if (short === 'pcm16-16k') {
    return DEFAULT_AUDIO_FORMAT;
  }
  if (short === 'pcm16-24k') {
    return 'pcm16;rate=24000;channels=1';
  }
  return audioFormat;
}

function resolveRoomName(
  voiceSlice: VoiceTransportConfig,
  voiceName: string,
  userId: string | undefined,
  sessionId: string,
): string {
  const resolver = voiceSlice.options?.roomResolver;
  if (typeof resolver === 'function') {
    return (resolver as LiveKitRoomResolver)({
      voiceName,
      userId: userId ?? DEFAULT_ROOM_USER,
      sessionId,
    });
  }

  const configuredRoom = voiceSlice.options?.room;
  if (typeof configuredRoom === 'string' && configuredRoom.length > 0) {
    return configuredRoom;
  }
  return `${voiceName}-${userId ?? DEFAULT_ROOM_USER}`;
}

function resolveIdentity(voiceName: string, userId?: string): string {
  return `${voiceName}:${userId ?? `anonymous:${randomUUID()}`}`;
}

function resolveAgentAudioTrackName(
  voiceSlice: VoiceTransportConfig,
  _voiceName: string,
  _identity: string,
): string {
  const configured = voiceSlice.options?.agentAudioTrackName;
  if (typeof configured === 'string' && configured.length > 0) {
    return configured;
  }
  return DEFAULT_AGENT_AUDIO_TRACK_NAME;
}

function resolveLiveKitTokenTtlSeconds(options: Record<string, unknown> | undefined): number {
  const value = options?.tokenTtlSeconds;
  return typeof value === 'number' && value > 0 ? clampTokenTtlSeconds(value) : DEFAULT_SESSION_TTL_SECONDS;
}

function resolveWorkerTokenTtlSeconds(options: Record<string, unknown> | undefined): number {
  const value = options?.workerTokenTtlSeconds;
  return typeof value === 'number' && value > 0 ? clampTokenTtlSeconds(value) : DEFAULT_SESSION_TTL_SECONDS;
}

function clampTokenTtlSeconds(value: number): number {
  return Math.min(Math.max(1, value), MAX_SESSION_TTL_SECONDS);
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function sanitizeAttributes(
  attributes: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!attributes) return undefined;
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string',
    ),
  );
}

function serializeMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  return JSON.stringify(metadata);
}

function pcmBytesToInt16(audio: Uint8Array): Int16Array {
  const buffer =
    audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength
      ? audio.buffer
      : audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
  return new Int16Array(buffer);
}

function int16ToBytes(frame: Int16Array): Uint8Array {
  return new Uint8Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
}

function parseLiveKitDataPayload(payload: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(payload).toString('utf-8')) as unknown;
  } catch {
    return { type: 'error', code: 'voice.invalid_message', message: 'Expected JSON control frame' };
  }
}
