import type { ExecutionContext, RouteGeneratorConfig } from '@plumbus/core';
import type { VoiceDefinition } from './voice.js';
import type { VoiceProvidersConfig } from './provider.js';
import type { VoiceSessionBudgetConfig } from './cost.js';

export interface VoiceBeforeSessionLiveKit {
  roomName: string;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, string>;
  identity?: string;
  tokenTtlSeconds?: number;
}

export interface VoiceBeforeSessionExecution {
  userId: string;
  tenantId: string;
  input?: Record<string, unknown>;
}

export type VoiceBeforeSessionResult =
  | { error: { status: number; body: unknown } }
  | {
      livekit?: VoiceBeforeSessionLiveKit;
      execution?: VoiceBeforeSessionExecution;
    };

export interface RegisterVoiceRoutesOpts {
  providers: VoiceProvidersConfig;
  authCookieNames?: string[];
  websocketOriginAllowlist?: readonly string[];
  sessionTokenSecret?: string;
  sessionTokenIssuer?: string;
  sessionTokenTtlSeconds?: number;
  registry?: import('../providers/registry.js').VoiceProviderRegistry;
  sessionBudget?: VoiceSessionBudgetConfig;
  sessionLifecycle?: {
    maxSessionDurationSeconds?: number;
    idleTimeoutSeconds?: number;
  };
  enableDebugEventStream?: boolean;
  beforeSession?: (
    ctx: ExecutionContext,
    voice: VoiceDefinition,
    rawBody: unknown,
  ) => Promise<VoiceBeforeSessionResult | undefined>;
  afterSession?: (ctx: ExecutionContext, voice: VoiceDefinition, session: unknown) => Promise<void>;
}

export type RegisterVoiceRoutes = (
  app: unknown,
  routeConfig: RouteGeneratorConfig,
  voices: VoiceDefinition[],
  opts: RegisterVoiceRoutesOpts,
) => void;
