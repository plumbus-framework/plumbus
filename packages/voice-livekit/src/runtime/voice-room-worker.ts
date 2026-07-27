import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  createSTTProvider,
  createTransportProvider,
  createTTSProvider,
  mergeRoomBrainInput,
  type VoiceProviderRegistry,
  VoiceSessionController,
  validateVoiceProviders,
} from '@plumbus/voice';
import {
  createVoiceSessionBudget,
  type VoiceDefinition,
  type VoiceProvidersConfig,
  type VoiceSessionBudgetConfig,
} from '@plumbus/voice/provider-kit';
import { DEFAULT_AGENT_AUDIO_TRACK_NAME } from '../client/session-helpers.js';
import { recordLiveKitTransportCost } from '../cost/record-livekit-transport.js';
import type {
  ConnectLiveKitWorkerArgs,
  LiveKitTransportProvider,
  LiveKitWorkerConnection,
} from '../types.js';

export { mergeRoomBrainInput };

export interface JoinVoiceRoomSessionOptions {
  voice: VoiceDefinition;
  providers: VoiceProvidersConfig;
  roomName: string;
  sessionId?: string;
  createExecutionContext: (args: {
    voiceName: string;
    sessionId: string;
    userId?: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
  }) => ExecutionContext;
  metadata?: Record<string, unknown>;
  userId?: string;
  tenantId?: string;
  brainInput?: Record<string, unknown>;
  signal?: AbortSignal;
  registry?: VoiceProviderRegistry;
  sessionBudget?: VoiceSessionBudgetConfig;
  connectLiveKitWorker?: (
    transport: LiveKitTransportProvider,
    args: ConnectLiveKitWorkerArgs,
  ) => Promise<LiveKitWorkerConnection>;
}

export interface VoiceRoomSessionHandle {
  sessionId: string;
  controller: VoiceSessionController;
  stop(): Promise<void>;
}

function assertLiveKitTransport(registry: VoiceProviderRegistry): VoiceProviderRegistry {
  if (registry.transport.has('livekit')) {
    return registry;
  }
  throw new PlumbusError(
    ErrorCode.DependencyViolation,
    'LiveKit room session registry must include transport.livekit (LIVEKIT_TRANSPORT_REGISTRATION)',
    { installPackage: '@plumbus/voice-livekit' },
  );
}

function resolveRoomRegistry(existing?: VoiceProviderRegistry): VoiceProviderRegistry {
  if (!existing) {
    throw new PlumbusError(
      ErrorCode.DependencyViolation,
      'LiveKit room session requires an explicit registry (pass LIVEKIT_TRANSPORT_REGISTRATION and STT/TTS registrations via createProviderRegistry, or export voiceProviderRegistry from app/voice/registry.ts)',
    );
  }
  return assertLiveKitTransport(existing);
}

export async function joinVoiceRoomSession(
  options: JoinVoiceRoomSessionOptions,
): Promise<VoiceRoomSessionHandle> {
  const registry = resolveRoomRegistry(options.registry);
  const validation = validateVoiceProviders({
    voices: [options.voice],
    providers: options.providers,
    registry,
  });
  if (!validation.ok) {
    const detail = validation.issues.map((issue) => issue.message).join('; ');
    throw new PlumbusError(
      ErrorCode.Validation,
      `Voice room session cannot start with invalid providers: ${detail}`,
    );
  }
  const sessionId = options.sessionId ?? options.roomName;
  const connectedAt = new Date();
  const metadata = options.metadata ?? {};
  const userId =
    options.userId ??
    (typeof metadata.userId === 'string' ? metadata.userId : undefined) ??
    'voice-worker';

  const ctx = options.createExecutionContext({
    voiceName: options.voice.name,
    sessionId,
    userId,
    tenantId:
      options.tenantId ?? (typeof metadata.tenantId === 'string' ? metadata.tenantId : undefined),
    metadata,
  });

  const transport = createTransportProvider({
    registry,
    providers: options.providers,
    voiceSlice: options.voice.transport,
  }) as LiveKitTransportProvider;

  const sttProvider = createSTTProvider({
    registry,
    providers: options.providers,
    voiceSlice: options.voice.stt,
  });
  const ttsProvider = createTTSProvider({
    registry,
    providers: options.providers,
    voiceSlice: options.voice.tts,
  });
  const budget = createVoiceSessionBudget(options.sessionBudget);

  const controller = new VoiceSessionController({
    voice: options.voice,
    sessionId,
    userId,
    ctx,
    sttProvider,
    ttsProvider,
    transportProvider: transport,
    budget,
    brainInput: mergeRoomBrainInput(options.brainInput, metadata),
    onEvent: async (event) => {
      await transport.sendData(event);
    },
    onAudioChunk: async (chunk) => {
      await transport.publishAudio(chunk);
    },
  });

  const workerArgs: ConnectLiveKitWorkerArgs = {
    voiceName: options.voice.name,
    room: options.roomName,
    identity: `voice-agent:${options.voice.name}`,
    metadata: JSON.stringify(metadata),
    agentAudioTrackName: resolveAgentTrackName(options.voice),
    signal: options.signal,
    onAudio: async (audio) => {
      await controller.handleAudioChunk(audio, options.voice.transport.audioFormat);
    },
    onData: async (payload) => {
      if (!payload || typeof payload !== 'object') return;
      await controller.handleControlMessage(payload as Record<string, unknown>);
    },
  };

  const connection = options.connectLiveKitWorker
    ? await options.connectLiveKitWorker(transport, workerArgs)
    : await transport.connectWorker(workerArgs);

  await controller.hello();

  return {
    sessionId,
    controller,
    async stop() {
      const disconnectedAt = new Date();
      await recordLiveKitTransportCost(ctx, {
        sessionId,
        connectedAt,
        disconnectedAt,
      });
      await controller.dispose();
      await connection.disconnect();
    },
  };
}

function resolveAgentTrackName(voice: VoiceDefinition): string {
  const configured = voice.transport.options?.agentAudioTrackName;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : DEFAULT_AGENT_AUDIO_TRACK_NAME;
}

export interface StartVoiceWorkerOptions {
  voices: VoiceDefinition[];
  providers: VoiceProvidersConfig;
  createExecutionContext: JoinVoiceRoomSessionOptions['createExecutionContext'];
  roomName?: string;
  sessionId?: string;
  voiceName?: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  tenantId?: string;
  brainInput?: Record<string, unknown>;
  signal?: AbortSignal;
  registry?: VoiceProviderRegistry;
  sessionBudget?: VoiceSessionBudgetConfig;
  connectLiveKitWorker?: (
    transport: LiveKitTransportProvider,
    args: ConnectLiveKitWorkerArgs,
  ) => Promise<LiveKitWorkerConnection>;
}

export interface VoiceWorkerHandle {
  sessionId: string;
  stop(): Promise<void>;
}

/** @deprecated Prefer joinVoiceRoomSession or startVoiceAgentWorker for per-room dispatch. */
export async function startVoiceWorker(
  options: StartVoiceWorkerOptions,
): Promise<VoiceWorkerHandle> {
  const livekitVoices = options.voices.filter((voice) => voice.transport.provider === 'livekit');
  if (livekitVoices.length === 0) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'startVoiceWorker requires at least one livekit voice',
    );
  }

  const selected =
    (options.voiceName
      ? livekitVoices.find((candidate) => candidate.name === options.voiceName)
      : undefined) ?? livekitVoices[0];
  if (!selected) {
    throw new PlumbusError(ErrorCode.Validation, 'startVoiceWorker could not resolve a voice');
  }

  const roomName = options.roomName ?? `voice-${randomUUID()}`;
  const handle = await joinVoiceRoomSession({
    voice: selected,
    providers: options.providers,
    roomName,
    sessionId: options.sessionId ?? roomName,
    createExecutionContext: options.createExecutionContext,
    metadata: options.metadata,
    userId: options.userId,
    tenantId: options.tenantId,
    brainInput: options.brainInput,
    signal: options.signal,
    registry: options.registry,
    sessionBudget: options.sessionBudget,
    connectLiveKitWorker: options.connectLiveKitWorker,
  });

  return {
    sessionId: handle.sessionId,
    stop: () => handle.stop(),
  };
}
