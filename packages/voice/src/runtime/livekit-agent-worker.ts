import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  AgentServer,
  AutoSubscribe,
  ServerOptions,
  defineAgent,
  type JobContext,
} from '@livekit/agents';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  type RemoteTrack,
  type Room,
} from '@livekit/rtc-node';
import type { ContextDependencies } from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core';
import { createProviderRegistry, validateVoiceProviders } from '../providers/registry.js';
import { createSTTProvider, createTTSProvider } from '../providers/factory.js';
import { createVoiceSessionBudget } from '../cost/session-budget.js';
import type { VoiceSessionBudgetConfig } from '../types/cost.js';
import type { VoiceDefinition } from '../types/voice.js';
import type { VoiceProvidersConfig } from '../types/provider.js';
import type { TransportProvider, TransportProviderSession } from '../providers/base/transport-provider.js';
import { consumeAudioStream } from './consume-audio-stream.js';
import { VoiceSessionController } from './voice-session-controller.js';

const activeSessions = new Set<VoiceSessionController>();

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
  registry?: ReturnType<typeof createProviderRegistry>;
  sessionBudget?: VoiceSessionBudgetConfig;
  agentName?: string;
  wsURL?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface VoiceAgentWorkerHandle {
  started: boolean;
  stop(): Promise<void>;
}

export interface VoiceAgentEntryOptions {
  voice: VoiceDefinition;
  providers: VoiceProvidersConfig;
  createDependencies: StartVoiceAgentWorkerOptions['createDependencies'];
  sessionBudget?: VoiceSessionBudgetConfig;
  registry?: ReturnType<typeof createProviderRegistry>;
}

interface VoiceAgentRuntimeConfig {
  voice: VoiceDefinition;
  providers: VoiceProvidersConfig;
  createDependencies: StartVoiceAgentWorkerOptions['createDependencies'];
  sessionBudget?: VoiceSessionBudgetConfig;
  registry: ReturnType<typeof createProviderRegistry>;
}

let runtimeConfig: VoiceAgentRuntimeConfig | undefined;

export function setVoiceAgentRuntimeConfig(config: VoiceAgentRuntimeConfig): void {
  runtimeConfig = config;
}

export function getVoiceAgentRuntimeConfig(): VoiceAgentRuntimeConfig {
  if (!runtimeConfig) {
    throw new Error('Voice agent runtime is not configured');
  }
  return runtimeConfig;
}

async function voiceAgentEntry(ctx: JobContext): Promise<void> {
  const config = getVoiceAgentRuntimeConfig();
  const { voice, providers, createDependencies, sessionBudget, registry } = config;

  const participant = await ctx.waitForParticipant();
  const participantIdentity = participant.identity ?? 'voice-user';
  const sessionId = `livekit:${voice.name}:${participantIdentity}:${randomUUID()}`;
  const executionCtx = createExecutionContext(
    createDependencies({
      userId: participantIdentity,
      roles: ['user'],
      scopes: [],
      provider: 'voice',
    }),
  );

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

  const transport = createRoomTransport(ctx.room, voice.transport.audioFormat ?? 'pcm16-16k');
  const sttProvider = createSTTProvider({ registry, providers, voiceSlice: voice.stt });
  const ttsProvider = createTTSProvider({ registry, providers, voiceSlice: voice.tts });
  const budget = createVoiceSessionBudget(sessionBudget);

  const controller = new VoiceSessionController({
    voice,
    sessionId,
    userId: participantIdentity,
    ctx: executionCtx,
    sttProvider,
    ttsProvider,
    transportProvider: transport,
    budget,
    onEvent: async (event) => {
      await transport.sendData?.(event);
    },
    onAudioChunk: async (chunk) => {
      await transport.publishAudio?.(chunk);
    },
  });

  ctx.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    const isAudio =
      track.kind === TrackKind.KIND_AUDIO || (track.kind as number | undefined) === 1;
    if (!isAudio) return;
    void forwardRemoteAudio(track, voice.transport.audioFormat, async (audio) => {
      await controller.handleAudioChunk(audio, voice.transport.audioFormat);
    });
  });

  ctx.room.on(RoomEvent.DataReceived, (payload) => {
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payload).toString('utf8'));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      await controller.handleControlMessage(parsed as Record<string, unknown>);
    })();
  });

  await controller.hello();
  activeSessions.add(controller);

  ctx.addShutdownCallback(async () => {
    activeSessions.delete(controller);
    await controller.dispose();
  });
}

const voiceAgentDefinition = defineAgent({
  entry: voiceAgentEntry,
});

export default voiceAgentDefinition;

export function createVoiceAgentEntry(options: VoiceAgentEntryOptions) {
  const registry = options.registry ?? createProviderRegistry();
  setVoiceAgentRuntimeConfig({
    voice: options.voice,
    providers: options.providers,
    createDependencies: options.createDependencies,
    sessionBudget: options.sessionBudget,
    registry,
  });
  return voiceAgentDefinition;
}

export async function stopActiveVoiceAgentSessions(): Promise<void> {
  const sessions = [...activeSessions];
  activeSessions.clear();
  await Promise.all(sessions.map((session) => session.dispose()));
}

export async function startVoiceAgentWorker(
  options: StartVoiceAgentWorkerOptions,
): Promise<VoiceAgentWorkerHandle> {
  const validation = validateVoiceProviders({
    voices: options.voices,
    providers: options.providers,
  });
  if (!validation.ok) {
    const detail = validation.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Voice agent worker cannot start with invalid providers: ${detail}`);
  }

  if (options.signal?.aborted) {
    throw new Error('Voice agent worker start aborted before initialization');
  }

  const livekitVoices = options.voices.filter((voice) => voice.transport.provider === 'livekit');
  if (livekitVoices.length === 0) {
    throw new Error('startVoiceAgentWorker requires at least one livekit voice');
  }

  const registry = options.registry ?? createProviderRegistry();
  setVoiceAgentRuntimeConfig({
    voice: livekitVoices[0]!,
    providers: options.providers,
    createDependencies: options.createDependencies,
    sessionBudget: options.sessionBudget,
    registry,
  });

  const server = new AgentServer(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: options.agentName ?? livekitVoices[0]!.name,
      wsURL: options.wsURL ?? process.env.LIVEKIT_URL,
      apiKey: options.apiKey ?? process.env.LIVEKIT_API_KEY,
      apiSecret: options.apiSecret ?? process.env.LIVEKIT_API_SECRET,
      requestFunc: async (job) => {
        await job.accept();
      },
    }),
  );

  const runPromise = server.run();

  if (options.signal) {
    options.signal.addEventListener(
      'abort',
      () => {
        void server.close();
      },
      { once: true },
    );
  }

  void runPromise.catch(() => {
    // Startup failures are surfaced when callers invoke stop().
  });

  return {
    started: true,
    async stop() {
      await stopActiveVoiceAgentSessions();
      await server.close();
    },
  };
}

function createRoomTransport(room: Room, audioFormat: string): TransportProvider {
  const trackName = 'dvora-voice';
  let audioSource: AudioSource | undefined;
  let localTrack: LocalAudioTrack | undefined;

  const ensurePublished = async () => {
    if (localTrack) return;
    const format = parsePcmFormat(audioFormat);
    audioSource = new AudioSource(format.sampleRate, format.channels);
    localTrack = LocalAudioTrack.createAudioTrack(trackName, audioSource);
    await room.localParticipant?.publishTrack(localTrack, new TrackPublishOptions());
  };

  return {
    async mintSession(args): Promise<TransportProviderSession> {
      return {
        sessionId: `livekit:${args.voiceName}:${args.userId ?? 'anonymous'}:${randomUUID()}`,
        transport: 'livekit',
      };
    },
    async publishAudio(audio) {
      await ensurePublished();
      if (!audioSource) return;
      const format = parsePcmFormat(audioFormat);
      const frame = new AudioFrame(
        pcmBytesToInt16(audio),
        format.sampleRate,
        format.channels,
        Math.max(1, audio.byteLength / (2 * format.channels)),
      );
      await audioSource.captureFrame(frame);
    },
    async sendData(payload) {
      if (!room.localParticipant) return;
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      await room.localParticipant.publishData(encoded, { reliable: true, topic: 'voice.events' });
    },
    async disconnect() {
      if (localTrack) await localTrack.close();
      if (audioSource) await audioSource.close();
      localTrack = undefined;
      audioSource = undefined;
    },
  };
}

async function forwardRemoteAudio(
  track: RemoteTrack,
  audioFormat: string | undefined,
  onAudio: (audio: Uint8Array) => Promise<void> | void,
): Promise<void> {
  const stream = new AudioStream(track, parsePcmFormat(audioFormat));
  await consumeAudioStream(stream, async (frame) => {
    await onAudio(
      new Uint8Array(
        frame.data.buffer.slice(frame.data.byteOffset, frame.data.byteOffset + frame.data.byteLength),
      ),
    );
  });
}

function parsePcmFormat(audioFormat: string | undefined): {
  sampleRate: number;
  channels: number;
} {
  const normalized = audioFormat ?? 'pcm16;rate=16000;channels=1';
  const rateMatch = normalized.match(/rate=(\d+)/);
  const channelsMatch = normalized.match(/channels=(\d+)/);
  return {
    sampleRate: Number(rateMatch?.[1] ?? 16000),
    channels: Number(channelsMatch?.[1] ?? 1),
  };
}

function pcmBytesToInt16(audio: Uint8Array): Int16Array {
  const buffer =
    audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength
      ? audio.buffer
      : audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
  return new Int16Array(buffer);
}
