// Type-only stand-in for `@plumbus/voice`. Used via the `paths` mapping in
// plumbus-core/tsconfig.json so voice CLI bridge files typecheck without
// resolving the real workspace package — voice peers on core, so Turbo builds
// core before voice; resolving to the real package requires voice `dist/`
// which does not exist yet and triggers TS2307 in CI.
//
// Keep this in sync with @plumbus/voice's public surface used by plumbus-core
// CLI bridges. LiveKit worker APIs live on `@plumbus/voice-livekit` and are
// typed locally in commands/voice.ts (runtime dynamic import).
//
// Relative imports below (not `@plumbus/core`) for the same reason as the MCP
// shim: avoid pulling plumbus-core's own dist back into the input set.
import type { RouteGeneratorConfig } from '../api/route-generator.js';
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

/** Opaque registry handle — CLI only passes it through to voice-livekit. */
export interface VoiceProviderRegistry {
  stt: ReadonlyMap<string, unknown>;
  tts: ReadonlyMap<string, unknown>;
  transport: ReadonlyMap<string, unknown>;
}

export interface AppVoiceRegistryModule {
  registry: VoiceProviderRegistry;
  providers?: VoiceProvidersConfig;
}

export declare function loadAppVoiceRegistry(options?: {
  appRoot?: string;
}): Promise<AppVoiceRegistryModule | null>;

export interface CreateVoiceExecutionContextFromRouteArgs {
  userId: string;
  tenantId?: string;
}

export declare function createVoiceExecutionContext(
  routeConfig: RouteGeneratorConfig,
  args: CreateVoiceExecutionContextFromRouteArgs,
): ExecutionContext;
