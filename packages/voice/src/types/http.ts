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
  /**
   * Public origin of the app (e.g. `https://app.example.com`). Together with
   * `csrfSecret` it enables Origin + CSRF checks on cookie-authenticated writes
   * (same model as `@plumbus/chat`). When set, `/session` also builds `wsUrl` from it (http→ws, https→wss) instead of request `Host` / `X-Forwarded-Proto` headers. Default: unset.
   */
  externalBaseUrl?: string;
  /**
   * HMAC secret for principal-bound CSRF tokens (cookie `plumbus_voice_csrf`,
   * echoed in header `x-plumbus-voice-csrf`). Enforcement is on only when both
   * `csrfSecret` and `externalBaseUrl` are set. Default: unset.
   */
  csrfSecret?: string;
  /**
   * Reject `?sessionToken=` on the websocket handshake; only the
   * `Sec-WebSocket-Protocol: voice-session.<token>` form is accepted. Default: false.
   */
  rejectQuerySessionToken?: boolean;
  /**
   * Accept each websocket handshake token once (its `jti` is recorded in a bounded
   * in-process store until it expires). Per process: with several replicas a token
   * can be redeemed once per replica. Default: false.
   */
  singleUseSessionTokens?: boolean;
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
  /**
   * Public origin of the app (e.g. `https://app.example.com`). Together with
   * `csrfSecret` it enables Origin + CSRF checks on cookie-authenticated writes
   * (same model as `@plumbus/chat`). Default: unset.
   */
  externalBaseUrl?: string;
  /**
   * HMAC secret for principal-bound CSRF tokens (cookie `plumbus_voice_csrf`,
   * echoed in header `x-plumbus-voice-csrf`). Enforcement is on only when both
   * `csrfSecret` and `externalBaseUrl` are set. Default: unset.
   */
  csrfSecret?: string;
}
