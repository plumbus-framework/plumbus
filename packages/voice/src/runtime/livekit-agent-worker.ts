import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  AgentServer,
  AutoSubscribe,
  ServerOptions,
  defineAgent,
  initializeLogger,
  type JobContext,
} from '@livekit/agents';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  type RemoteTrack,
  type Room,
} from '@livekit/rtc-node';
import type { ContextDependencies } from '@plumbus/core';
import { ErrorCode, PlumbusError, createExecutionContext } from '@plumbus/core';
import { createProviderRegistry, validateVoiceProviders } from '../providers/registry.js';
import { createSTTProvider, createTTSProvider } from '../providers/factory.js';
import { createVoiceSessionBudget } from '../cost/session-budget.js';
import { recordLiveKitTransportCost } from '../cost/record-livekit-transport.js';
import type { VoiceSessionBudgetConfig } from '../types/cost.js';
import type { VoiceDefinition } from '../types/voice.js';
import type { VoiceProvidersConfig } from '../types/provider.js';
import type {
  TransportProvider,
  TransportProviderSession,
} from '../providers/base/transport-provider.js';
import { DEFAULT_AGENT_AUDIO_TRACK_NAME } from '../client/livekit-session-helpers.js';
import { consumeAudioStream } from './consume-audio-stream.js';
import { createInboundAudioStream } from './noise-cancellation/create-inbound-audio-stream.js';
import { readNoiseCancellationFromTransportOptions } from './noise-cancellation/parse-noise-cancellation.js';
import {
  buildBrainInputFromParticipantContext,
  parseLiveKitParticipantContext,
} from './parse-livekit-participant-context.js';
import { VoiceSessionController } from './voice-session-controller.js';

const activeSessions = new Set<VoiceSessionController>();

let liveKitAgentLoggerReady = false;

export function ensureLiveKitAgentLogger(): void {
  if (liveKitAgentLoggerReady) {
    return;
  }
  initializeLogger({
    pretty: process.env.NODE_ENV !== 'production',
    level: process.env.LIVEKIT_LOG_LEVEL ?? 'info',
  });
  liveKitAgentLoggerReady = true;
}

export function resetLiveKitAgentLoggerForTests(): void {
  liveKitAgentLoggerReady = false;
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
  registry?: ReturnType<typeof createProviderRegistry>;
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

const voiceAgentConfigs = new Map<string, VoiceAgentRuntimeConfig>();

export const PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV = 'PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE';

let bootstrapInFlight: Promise<void> | undefined;

export function resetVoiceAgentConfigsForTests(): void {
  voiceAgentConfigs.clear();
  bootstrapInFlight = undefined;
}

function buildVoiceAgentRuntimeConfig(options: VoiceAgentEntryOptions): VoiceAgentRuntimeConfig {
  return {
    voice: options.voice,
    providers: options.providers,
    createDependencies: options.createDependencies,
    sessionBudget: options.sessionBudget,
    registry: options.registry ?? createProviderRegistry(),
  };
}

export function resolveVoiceAgentConfig(agentName: string | undefined): VoiceAgentRuntimeConfig {
  if (agentName) {
    const named = voiceAgentConfigs.get(agentName);
    if (named) {
      return named;
    }
  }

  if (voiceAgentConfigs.size === 1) {
    const only = voiceAgentConfigs.values().next().value;
    if (only) {
      return only;
    }
  }

  throw new PlumbusError(
    ErrorCode.DependencyViolation,
    'Voice agent runtime is not configured for this agent dispatch',
    { agentName },
  );
}

interface VoiceAgentBootstrapPayload {
  voices: VoiceDefinition[];
  providers: VoiceProvidersConfig;
  createDependencies: StartVoiceAgentWorkerOptions['createDependencies'];
  sessionBudget?: VoiceSessionBudgetConfig;
}

function registerVoiceAgentBootstrapPayload(payload: VoiceAgentBootstrapPayload): void {
  const validation = validateVoiceProviders({
    voices: payload.voices,
    providers: payload.providers,
  });
  if (!validation.ok) {
    const detail = validation.issues.map((issue) => issue.message).join('; ');
    throw new PlumbusError(
      ErrorCode.Validation,
      `Voice agent bootstrap has invalid providers: ${detail}`,
    );
  }

  const registry = createProviderRegistry();
  const livekitVoices = payload.voices.filter((voice) => voice.transport.provider === 'livekit');
  if (livekitVoices.length === 0) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'Voice agent bootstrap requires at least one livekit voice',
    );
  }

  for (const voice of livekitVoices) {
    voiceAgentConfigs.set(
      voice.name,
      buildVoiceAgentRuntimeConfig({
        voice,
        providers: payload.providers,
        createDependencies: payload.createDependencies,
        sessionBudget: payload.sessionBudget,
        registry,
      }),
    );
  }
}

export async function bootstrapVoiceAgentConfigsFromModule(): Promise<void> {
  if (bootstrapInFlight) {
    await bootstrapInFlight;
    return;
  }

  bootstrapInFlight = (async () => {
    const modulePath = process.env[PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV];
    if (!modulePath) {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'Voice agent child process bootstrap module is not configured',
        { env: PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV },
      );
    }

    const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const bootstrap = mod.bootstrapVoiceAgentRuntime;
    if (typeof bootstrap !== 'function') {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'Voice agent bootstrap module must export bootstrapVoiceAgentRuntime()',
        { modulePath },
      );
    }

    const payload = (await bootstrap()) as VoiceAgentBootstrapPayload;
    registerVoiceAgentBootstrapPayload(payload);
  })();

  try {
    await bootstrapInFlight;
  } catch (error) {
    bootstrapInFlight = undefined;
    throw error;
  }
}

async function resolveVoiceAgentConfigForJob(
  agentName: string | undefined,
): Promise<VoiceAgentRuntimeConfig> {
  try {
    return resolveVoiceAgentConfig(agentName);
  } catch (error) {
    if (!(error instanceof PlumbusError) || error.code !== ErrorCode.DependencyViolation) {
      throw error;
    }

    console.info('[voice-agent] bootstrapping runtime config in child process', { agentName });
    await bootstrapVoiceAgentConfigsFromModule();
    return resolveVoiceAgentConfig(agentName);
  }
}

function resolveAgentTrackName(voice: VoiceDefinition): string {
  const configured = voice.transport.options?.agentAudioTrackName;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : DEFAULT_AGENT_AUDIO_TRACK_NAME;
}

function resolveLiveKitVoice(voices: VoiceDefinition[], agentName?: string): VoiceDefinition {
  const livekitVoices = voices.filter((voice) => voice.transport.provider === 'livekit');
  if (livekitVoices.length === 0) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'startVoiceAgentWorker requires at least one livekit voice',
    );
  }

  const selectedName = agentName ?? livekitVoices[0]?.name;
  if (!selectedName) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'startVoiceAgentWorker could not resolve a livekit voice name',
    );
  }

  const voice = livekitVoices.find((candidate) => candidate.name === selectedName);
  if (!voice) {
    throw new PlumbusError(
      ErrorCode.NotFound,
      `No livekit voice definition found for agent name "${selectedName}"`,
      { agentName: selectedName },
    );
  }

  return voice;
}

function resolveLiveKitHost(url?: string): string {
  if (!url) {
    return 'unknown';
  }
  try {
    const normalized = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    return new URL(normalized).host;
  } catch {
    return 'unknown';
  }
}

function normalizeVoiceLanguage(language: string | undefined): string | undefined {
  const normalized = language?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('he')) {
    return 'he';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  return undefined;
}

function applySessionLanguageToVoice(
  voice: VoiceDefinition,
  language: string | undefined,
): VoiceDefinition {
  const normalizedLanguage = normalizeVoiceLanguage(language);
  if (!normalizedLanguage) {
    return voice;
  }

  return {
    ...voice,
    stt: {
      ...voice.stt,
      languages: [normalizedLanguage],
    },
  };
}

async function runVoiceAgentEntry(ctx: JobContext, config: VoiceAgentRuntimeConfig): Promise<void> {
  const { voice, providers, createDependencies, sessionBudget, registry } = config;

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  const connectedAt = new Date();

  console.info('[voice-agent] job started', {
    voice: voice.name,
    room: ctx.room.name ?? '',
  });

  const participant = await ctx.waitForParticipant();
  const participantIdentity = participant.identity ?? 'voice-user';
  const participantContext = parseLiveKitParticipantContext({
    roomName: ctx.room.name ?? '',
    participantIdentity,
    participantMetadata: participant.metadata,
    participantAttributes: participant.attributes,
  });
  const sessionId = participantContext.sessionId;
  const brainInput = buildBrainInputFromParticipantContext(participantContext);
  const sessionVoice = applySessionLanguageToVoice(voice, participantContext.language);

  console.info('[voice-agent] participant joined', {
    voice: sessionVoice.name,
    room: ctx.room.name ?? '',
    participant: participantIdentity,
    sessionId,
    language: participantContext.language,
  });

  const executionCtx = createExecutionContext(
    createDependencies({
      userId: participantContext.userId,
      tenantId: participantContext.tenantId,
      roles: ['user'],
      scopes: [],
      provider: 'voice',
    }),
  );

  const trackName = resolveAgentTrackName(sessionVoice);
  const ttsSampleRate =
    typeof sessionVoice.tts.options?.sampleRate === 'number'
      ? sessionVoice.tts.options.sampleRate
      : undefined;
  const outputAudioFormat = ttsSampleRate
    ? `pcm16;rate=${ttsSampleRate};channels=1`
    : (sessionVoice.transport.audioFormat ?? 'pcm16-16k');
  const transport = createRoomTransport(
    ctx.room,
    sessionVoice.transport.audioFormat ?? 'pcm16-16k',
    trackName,
    outputAudioFormat,
  );
  const sttProvider = createSTTProvider({ registry, providers, voiceSlice: sessionVoice.stt });
  const ttsProvider = createTTSProvider({ registry, providers, voiceSlice: sessionVoice.tts });
  const budget = createVoiceSessionBudget(sessionBudget);

  const controller = new VoiceSessionController({
    voice: sessionVoice,
    sessionId,
    userId: participantContext.userId,
    ctx: executionCtx,
    sttProvider,
    ttsProvider,
    transportProvider: transport,
    budget,
    brainInput,
    onEvent: async (event) => {
      await transport.sendData?.(event);
    },
  });

  ctx.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    const isAudio = track.kind === TrackKind.KIND_AUDIO || (track.kind as number | undefined) === 1;
    if (!isAudio) return;
    let loggedFirstAudio = false;
    void forwardRemoteAudio(
      track,
      sessionVoice.transport.audioFormat,
      readNoiseCancellationFromTransportOptions(sessionVoice.transport.options),
      async (audio) => {
        if (!loggedFirstAudio) {
          loggedFirstAudio = true;
          console.info('[voice-agent] first remote audio frame received', {
            voice: sessionVoice.name,
            room: ctx.room.name ?? '',
            participant: participantIdentity,
            sessionId,
            bytes: audio.byteLength,
          });
        }
        await controller.handleAudioChunk(audio, sessionVoice.transport.audioFormat);
      },
    );
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
  console.info('[voice-agent] session hello sent', {
    voice: sessionVoice.name,
    sessionId,
    room: ctx.room.name ?? '',
  });
  activeSessions.add(controller);

  ctx.addShutdownCallback(async () => {
    activeSessions.delete(controller);
    if (participantContext.projectId) {
      await recordLiveKitTransportCost(executionCtx, {
        sessionId,
        connectedAt,
        disconnectedAt: new Date(),
        costContext: {
          projectId: participantContext.projectId,
          relatedEntityType: 'InterviewSession',
          relatedEntityId: sessionId,
        },
      });
    }
    await controller.dispose();
  });
}

async function voiceAgentEntry(ctx: JobContext): Promise<void> {
  const jobRecord = ctx.job as { agentName?: string; agent_name?: string };
  const agentName = jobRecord.agentName ?? jobRecord.agent_name;
  const config = await resolveVoiceAgentConfigForJob(
    typeof agentName === 'string' && agentName.length > 0 ? agentName : undefined,
  );
  await runVoiceAgentEntry(ctx, config);
}

const voiceAgentDefinition = defineAgent({
  entry: voiceAgentEntry,
});

export default voiceAgentDefinition;

export function createVoiceAgentEntry(options: VoiceAgentEntryOptions) {
  const config = buildVoiceAgentRuntimeConfig(options);
  voiceAgentConfigs.set(options.voice.name, config);
  return defineAgent({
    entry: (ctx) => runVoiceAgentEntry(ctx, config),
  });
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
    throw new PlumbusError(
      ErrorCode.Validation,
      `Voice agent worker cannot start with invalid providers: ${detail}`,
    );
  }

  if (options.signal?.aborted) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'Voice agent worker start aborted before initialization',
    );
  }

  const voice = resolveLiveKitVoice(options.voices, options.agentName);
  const registry = options.registry ?? createProviderRegistry();
  const runtimeConfig = buildVoiceAgentRuntimeConfig({
    voice,
    providers: options.providers,
    createDependencies: options.createDependencies,
    sessionBudget: options.sessionBudget,
    registry,
  });
  voiceAgentConfigs.set(voice.name, runtimeConfig);

  const bootstrapModule =
    options.bootstrapModule ?? process.env[PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV];
  if (bootstrapModule) {
    process.env[PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV] = bootstrapModule;
  }

  ensureLiveKitAgentLogger();

  const resolvedAgentName = options.agentName ?? voice.name;
  const wsURL = options.wsURL ?? process.env.LIVEKIT_URL;
  console.info('[voice-agent] worker started', {
    agentName: resolvedAgentName,
    livekitHost: resolveLiveKitHost(wsURL),
  });

  const server = new AgentServer(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: resolvedAgentName,
      wsURL,
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
      voiceAgentConfigs.delete(voice.name);
    },
  };
}

export function createRoomTransport(
  room: Room,
  audioFormat: string,
  trackName: string,
  outputAudioFormat: string = audioFormat,
): TransportProvider {
  let audioSource: AudioSource | undefined;
  let localTrack: LocalAudioTrack | undefined;
  let loggedFirstDataEvent = false;
  let loggedFirstAudioPublish = false;

  const ensurePublished = async () => {
    if (localTrack) return;
    const format = parsePcmFormat(outputAudioFormat);
    audioSource = new AudioSource(format.sampleRate, format.channels);
    localTrack = LocalAudioTrack.createAudioTrack(trackName, audioSource);
    const publishOptions = new TrackPublishOptions() as TrackPublishOptions & { name?: string };
    publishOptions.name = trackName;
    await room.localParticipant?.publishTrack(localTrack, publishOptions);
    console.info('[voice-agent] audio track published', {
      trackName,
      sampleRate: format.sampleRate,
      channels: format.channels,
    });
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
      const format = parsePcmFormat(outputAudioFormat);
      const frame = new AudioFrame(
        pcmBytesToInt16(audio),
        format.sampleRate,
        format.channels,
        Math.max(1, audio.byteLength / (2 * format.channels)),
      );
      await audioSource.captureFrame(frame);
      if (!loggedFirstAudioPublish) {
        loggedFirstAudioPublish = true;
        console.info('[voice-agent] first agent audio frame published', {
          trackName,
          bytes: audio.byteLength,
          samplesPerChannel: Math.max(1, audio.byteLength / (2 * format.channels)),
        });
      }
    },
    async sendData(payload) {
      const payloadType =
        typeof payload === 'object' && payload !== null
          ? (payload as { type?: unknown }).type
          : undefined;
      if (!room.localParticipant) {
        console.warn('[voice-agent] data event dropped before local participant was ready', {
          type: payloadType,
        });
        return;
      }
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      await room.localParticipant.publishData(encoded, { reliable: true, topic: 'voice.events' });
      if (!loggedFirstDataEvent) {
        loggedFirstDataEvent = true;
        console.info('[voice-agent] first data event published', {
          type: payloadType,
        });
      }
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
  noiseCancellation: ReturnType<typeof readNoiseCancellationFromTransportOptions>,
  onAudio: (audio: Uint8Array) => Promise<void> | void,
): Promise<void> {
  const format = parsePcmFormat(audioFormat);
  const stream = createInboundAudioStream(track, format, noiseCancellation);
  await consumeAudioStream(stream, async (frame) => {
    await onAudio(
      new Uint8Array(
        frame.data.buffer.slice(
          frame.data.byteOffset,
          frame.data.byteOffset + frame.data.byteLength,
        ),
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
