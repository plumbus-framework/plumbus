// Type-only stand-in for `@plumbus/voice`. Used via the `paths` mapping in
// plumbus-core/tsconfig.json so voice CLI bridge files typecheck without
// resolving the real workspace package — voice peers on core, so Turbo builds
// core before voice; resolving to the real package requires voice `dist/`
// which does not exist yet and triggers TS2307 in CI.
//
// Keep this in sync with @plumbus/voice's public surface used by plumbus-core
// CLI bridges (packages/voice/src/index.ts); out-of-sync signatures will
// quietly miscompile our CLI bridge.
//
// Relative imports below (not `@plumbus/core`) for the same reason as the MCP
// shim: avoid pulling plumbus-core's own dist back into the input set.
import type { RouteGeneratorConfig } from '../api/route-generator.js';
import type { ContextDependencies } from '../execution/context-factory.js';
import type { ExecutionContext } from '../types/context.js';

export interface VoiceTransportConfig {
  provider: string;
  mode?: string;
  audioFormat?: string;
  options?: Record<string, unknown>;
}

export interface VoiceDefinition {
  kind: 'voice';
  name: string;
  description?: string;
  transport: VoiceTransportConfig;
  stt: {
    provider: string;
    model?: string;
    languages?: string[];
    options?: Record<string, unknown>;
  };
  tts: {
    provider: string;
    model?: string;
    voiceId?: string;
    locale?: string;
    options?: Record<string, unknown>;
  };
  instructions: string[];
}

export interface VoiceProviderCredentials {
  apiKey?: string;
  apiSecret?: string;
  url?: string;
  baseUrl?: string;
  options?: Record<string, unknown>;
}

export interface VoiceProvidersConfig {
  providers: Record<string, VoiceProviderCredentials>;
}

export interface VoiceSessionBudgetConfig {
  maxConnectionMinutes?: number;
  maxParticipantMinutes?: number;
  maxAudioInputSeconds?: number;
  maxConcurrentStreams?: number;
  maxSttCharacters?: number;
  maxSessionDurationSeconds?: number;
  idleTimeoutSeconds?: number;
}

export interface DiscoverVoicesOptions {
  appRoot?: string;
}

export declare function discoverVoices(options?: DiscoverVoicesOptions): Promise<VoiceDefinition[]>;

export declare function resolveVoiceProvidersFromEnv(
  config?: Record<string, unknown>,
): VoiceProvidersConfig;

export interface VoiceAgentAuth {
  userId: string;
  tenantId?: string;
  roles: string[];
  scopes: string[];
  provider: string;
}

export interface StartVoiceAgentWorkerOptions {
  voices: VoiceDefinition[];
  providers: VoiceProvidersConfig;
  createDependencies: (auth: VoiceAgentAuth) => ContextDependencies;
  signal?: AbortSignal;
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

export declare function startVoiceAgentWorker(
  options: StartVoiceAgentWorkerOptions,
): Promise<VoiceAgentWorkerHandle>;

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
  sessionBudget?: VoiceSessionBudgetConfig;
}

export interface VoiceRoomSessionHandle {
  sessionId: string;
  stop(): Promise<void>;
}

export declare function joinVoiceRoomSession(
  options: JoinVoiceRoomSessionOptions,
): Promise<VoiceRoomSessionHandle>;

export interface CreateVoiceExecutionContextFromRouteArgs {
  userId: string;
  tenantId?: string;
}

export declare function createVoiceExecutionContext(
  routeConfig: RouteGeneratorConfig,
  args: CreateVoiceExecutionContextFromRouteArgs,
): ExecutionContext;
