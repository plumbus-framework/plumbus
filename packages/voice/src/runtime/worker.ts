import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import { DEFAULT_AGENT_AUDIO_TRACK_NAME } from '../client/livekit-session-helpers.js';
import { createProviderRegistry, validateVoiceProviders } from '../providers/registry.js';
import {
  createSTTProvider,
  createTTSProvider,
  createTransportProvider,
} from '../providers/factory.js';
import { recordLiveKitTransportCost } from '../cost/record-livekit-transport.js';
import { createVoiceSessionBudget } from '../cost/session-budget.js';
import type { VoiceSessionBudgetConfig } from '../types/cost.js';
import type {
  LiveKitTransportProvider,
  ConnectLiveKitWorkerArgs,
  LiveKitWorkerConnection,
} from '../providers/transport/livekit-transport.js';
import type { VoiceDefinition } from '../types/voice.js';
import type { VoiceProvidersConfig } from '../types/provider.js';
import { VoiceSessionController } from './voice-session-controller.js';

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
  registry?: ReturnType<typeof createProviderRegistry>;
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

export function mergeRoomBrainInput(
  brainInput: Record<string, unknown> | undefined,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...brainInput,
    ...(typeof metadata.projectId === 'string' ? { projectId: metadata.projectId } : {}),
    ...(typeof metadata.sessionId === 'string' ? { sessionId: metadata.sessionId } : {}),
    ...(typeof metadata.language === 'string' ? { language: metadata.language } : {}),
  };
}

export async function joinVoiceRoomSession(
  options: JoinVoiceRoomSessionOptions,
): Promise<VoiceRoomSessionHandle> {
  const validation = validateVoiceProviders({
    voices: [options.voice],
    providers: options.providers,
  });
  if (!validation.ok) {
    const detail = validation.issues.map((issue) => issue.message).join('; ');
    throw new PlumbusError(
      ErrorCode.Validation,
      `Voice room session cannot start with invalid providers: ${detail}`,
    );
  }

  const registry = options.registry ?? createProviderRegistry();
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
  createExecutionContext: (args: {
    voiceName: string;
    sessionId: string;
    userId?: string;
  }) => ExecutionContext;
  signal?: AbortSignal;
  onStart?: () => Promise<void> | void;
  registry?: ReturnType<typeof createProviderRegistry>;
  sessionBudget?: VoiceSessionBudgetConfig;
  /** @deprecated Prefer joinVoiceRoomSession or startVoiceAgentWorker for per-room dispatch. */
  rooms?: Array<{ voiceName: string; roomName: string; metadata?: Record<string, unknown> }>;
  connectLiveKitWorker?: (
    transport: LiveKitTransportProvider,
    args: ConnectLiveKitWorkerArgs,
  ) => Promise<LiveKitWorkerConnection>;
}

export interface VoiceWorkerHandle {
  started: boolean;
  stop(): Promise<void>;
}

export async function startVoiceWorker(
  options: StartVoiceWorkerOptions,
): Promise<VoiceWorkerHandle> {
  if (!options.createExecutionContext) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'startVoiceWorker requires createExecutionContext',
    );
  }

  const livekitVoices = options.voices.filter((voice) => voice.transport.provider === 'livekit');
  const sessions: VoiceRoomSessionHandle[] = [];

  if (options.rooms && options.rooms.length > 0) {
    for (const room of options.rooms) {
      const voice = livekitVoices.find((candidate) => candidate.name === room.voiceName);
      if (!voice) continue;
      const handle = await joinVoiceRoomSession({
        voice,
        providers: options.providers,
        roomName: room.roomName,
        sessionId: room.roomName,
        metadata: room.metadata,
        createExecutionContext: options.createExecutionContext,
        signal: options.signal,
        registry: options.registry,
        sessionBudget: options.sessionBudget,
        connectLiveKitWorker: options.connectLiveKitWorker,
      });
      sessions.push(handle);
    }
  } else {
    for (const voice of livekitVoices) {
      const sessionId = `livekit:${voice.name}:worker:${randomUUID()}`;
      const handle = await joinVoiceRoomSession({
        voice,
        providers: options.providers,
        roomName: sessionId,
        sessionId,
        createExecutionContext: options.createExecutionContext,
        signal: options.signal,
        registry: options.registry,
        sessionBudget: options.sessionBudget,
        connectLiveKitWorker: options.connectLiveKitWorker,
      });
      sessions.push(handle);
    }
  }

  await options.onStart?.();

  return {
    started: sessions.length > 0,
    async stop() {
      for (const session of sessions) {
        await session.stop();
      }
    },
  };
}
