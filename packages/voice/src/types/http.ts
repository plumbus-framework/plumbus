import type { AccessPolicy, ExecutionContext, RouteGeneratorConfig } from '@plumbus/core';
import type { ClonedVoice } from './clone.js';
import type { VoiceSessionBudgetConfig } from './cost.js';
import type { VoiceProvidersConfig } from './provider.js';
import type { VoiceDefinition } from './voice.js';

/** Room / participant mint options for transport-agnostic `POST /token`. */
export interface VoiceBeforeSessionRoom {
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
      room?: VoiceBeforeSessionRoom;
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
  /** Optional lazy registry resolver used by HTTP routes when `registry` is omitted. */
  resolveRegistry?: () => Promise<import('../providers/registry.js').VoiceProviderRegistry>;
  sessionBudget?: VoiceSessionBudgetConfig;
  sessionLifecycle?: {
    maxSessionDurationSeconds?: number;
    idleTimeoutSeconds?: number;
  };
  enableCallEventStream?: boolean;
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

/** Auth principal returned by `routeConfig.authAdapter.authenticate`. */
export type VoiceCloneAuth = NonNullable<
  Awaited<ReturnType<RouteGeneratorConfig['authAdapter']['authenticate']>>
>;

export interface RegisterVoiceCloneRoutesOpts {
  providers: VoiceProvidersConfig;
  registry?: import('../providers/registry.js').VoiceProviderRegistry;
  resolveRegistry?: () => Promise<import('../providers/registry.js').VoiceProviderRegistry>;
  authCookieNames?: string[];
  /** Who may call clone lifecycle routes (create/get/delete/wait/recompute). */
  access: AccessPolicy;
  /**
   * Stricter policy for POST .../synthesize-reference (spoofing surface).
   * When unset, that route is not registered.
   */
  referenceAccess?: AccessPolicy;
  resolveCloneOwner: (args: {
    providerId: string;
    voiceId: string;
    auth: VoiceCloneAuth;
  }) => Promise<string | null>;
  afterCloneCreate: (args: {
    providerId: string;
    voice: ClonedVoice;
    auth: VoiceCloneAuth;
  }) => Promise<void>;
  afterCloneDelete?: (args: {
    providerId: string;
    voiceId: string;
    auth: VoiceCloneAuth;
  }) => Promise<void>;
  /** App DB list of clones owned by the principal. */
  listOwnedClones: (args: { providerId: string; auth: VoiceCloneAuth }) => Promise<ClonedVoice[]>;
  maxSampleBytes?: number;
}
