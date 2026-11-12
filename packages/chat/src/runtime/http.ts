import type { AuthContext, ExecutionContext } from '@plumbus/core';
import type { RouteGeneratorConfig } from '@plumbus/core';
import { errorToHttpResponse, evaluateAccess, isPlumbusError } from '@plumbus/core/sdk';
import { createExecutionContext } from '@plumbus/core/runtime';
import { z } from '@plumbus/core/zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { chatActionRejectedEvent } from '../events/chat-events.js';
import type { ChatPendingActionV2 } from '../session/pending-action-v2.js';
import { assertChatStoresSupportChats, type ChatSessionStore } from '../session/session-store.js';
import type { ChatDefinition } from '../types/chat.js';
import type { ChatEvent } from '../types/event.js';
import type { ChatReplyValidator } from '../types/reply.js';
import { resolveToolBinding } from './bind-tools.js';
import type { ChatConversationStore } from './chat-conversation-store.js';
import type { ChatRegistry } from './chat-registry.js';
import { capClientHistory, validateClientHistorySize } from './constants.js';
import {
  CHAT_CSRF_COOKIE_NAME,
  CHAT_CSRF_HEADER_NAME,
  csrfBindingFromAuth,
  issueCsrfToken,
  originAllowed,
  verifyCsrfToken,
} from './csrf.js';
import { checkLivePending } from './pending-actions.js';
import { type ChatConfirmResult, resumeAfterConfirm } from './resume-after-confirm.js';
import type { RunChatTurnOpts } from './run-turn.js';
import { runChatTurn } from './run-turn.js';

const turnBodySchema = z
  .object({
    sessionId: z.string().guid(),
    userMessage: z.string().min(1),
    audience: z.string(),
    locale: z.string(),
    clientHistory: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
          refusalReason: z
            .enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request'])
            .nullable()
            .optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

const confirmBodySchema = z
  .object({
    actionId: z.string().guid(),
    /** Echoed from the confirmation_required event; server derives capability/input from storage. */
    inputSchemaHash: z.string().min(1),
    decision: z.enum(['confirm', 'reject']),
  })
  .passthrough();

export type ChatTurnParsedBody = z.infer<typeof turnBodySchema>;

/** D3 — reused by /turn and /confirm. */
export interface ChatRequestAuthentication {
  auth: AuthContext;
  credentialSource: 'authorization_header' | 'cookie';
}

/**
 * D3 — Authorization-header credentials take precedence over cookies. When
 * credentialSource === 'cookie', callers enforce exact-Origin + session-bound CSRF.
 */
export interface ChatRequestAuthenticator {
  authenticate(request: unknown): Promise<ChatRequestAuthentication>;
}

/** Appendix A.9 — options bag shape (fields folded into RegisterChatRoutesOpts). */
export interface ChatHttpOptions {
  authCookieNames?: string[];
  /** REQUIRED when browser CSRF is enabled; its normalized origin is the only accepted browser origin. */
  externalBaseUrl?: string;
  authenticator: ChatRequestAuthenticator;
}

/** A refusal a seam hook asks the route to send instead of running the turn. */
export interface ChatRouteRefusal {
  status: number;
  body: unknown;
}

/** Arguments every request-context hook receives. */
export interface ChatRequestContextArgs {
  /** The Fastify request (hostname, headers, ip). */
  request: FastifyRequest;
  /** The authenticated caller. Hooks may read it; tenant changes go through `bindTenant`. */
  auth: AuthContext;
  chat: ChatDefinition;
  /** `turn` for `POST /chat/:name/turn`, `confirm` for `POST /chat/:name/confirm`. */
  route: 'turn' | 'confirm';
}

/**
 * The app's request-context seam for chat routes (opt-in; every field is
 * optional and an absent field keeps the previous behavior).
 *
 * Order on `/turn` and `/confirm`: authenticate → body → browser Origin/CSRF →
 * `bindTenant` → build dependencies (`dependencies`) → chat access → `checkSession`
 * → pending-action check → `beforeTurn` → `prepareTurn` → turn.
 */
export interface ChatRequestContextSeam {
  /**
   * How the request's `ExecutionContext` dependencies are built.
   * - `'create'` (default): `routeConfig.createDependencies(auth)`, as before.
   * - `'route-config'`: `routeConfig.resolveDependencies(auth, { bypassTenantScope, locale })`
   *   when the app supplies one (falling back to `createDependencies`) — the seam
   *   capability routes use, so an app's tenant binding and session-liveness
   *   gates installed there run for chat turns too. A thrown `PlumbusError` keeps
   *   its HTTP status and code; anything else is a 500. Chat access is then
   *   evaluated against the context's `auth` (after the resolver bound the tenant).
   */
  dependencies?: 'create' | 'route-config';
  /**
   * Decide the request's tenant from the request itself (e.g. its hostname).
   * Return `{ tenantId }` to bind it (it replaces any tenant the credential
   * claimed; `undefined` clears the claim, so `tenantScoped` chats are refused),
   * or `{ refuse }` to send that response. Throwing a `PlumbusError` maps to its
   * status. When set, `audienceTenantOverride` is not applied: a body field must
   * never choose the tenant.
   */
  bindTenant?: (
    args: ChatRequestContextArgs,
  ) => Promise<{ tenantId: string | undefined } | { refuse: ChatRouteRefusal }>;
  /**
   * Is the caller's session still live (not revoked, not expired)? `false`
   * refuses with 401 `{ error: { code: 'chat.session_not_live' } }`; a thrown
   * `PlumbusError` maps to its status. Runs after access evaluation, before any
   * pending-action read or model call.
   */
  checkSession?: (args: ChatRequestContextArgs & { ctx: ExecutionContext }) => Promise<boolean>;
}

/** Per-turn, server-owned turn inputs from the app (see `RegisterChatRoutesOpts.prepareTurn`). */
export interface ChatPreparedTurn {
  /** Server-owned prompt fields merged into the custom prompt's input (`RunChatTurnArgs.promptInput`). */
  promptInput?: Record<string, unknown>;
  /** Server-authoritative history for this turn (`RunChatTurnArgs.trustedHistory`). */
  trustedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Per-turn reply check; wins over the route-level `validateReply`. */
  validateReply?: ChatReplyValidator;
}

export interface RegisterChatRoutesOpts {
  authCookieNames?: string[];
  /** REQUIRED for chats with policy.toolCalling.enabled; supplies chat.toolRound /
   *  chat.scopeCheck registration status (D5). Build via createChatRegistry(promptRegistry). */
  chatRegistry?: ChatRegistry;
  audienceTenantOverride?: (audience: string, auth: { tenantId?: string }) => string | undefined;
  beforeTurn?: (
    ctx: ExecutionContext,
    parsed: ChatTurnParsedBody,
    rawBody: unknown,
  ) => Promise<{ userMessage?: string } | { error: { status: number; body: unknown } }>;
  afterTurn?: (ctx: ExecutionContext, rawBody: unknown, events: ChatEvent[]) => Promise<void>;
  /** Opt-in request-context seam: tenant binding, dependency resolution, session liveness. */
  requestContext?: ChatRequestContextSeam;
  /**
   * Fill server-owned turn inputs per turn (prompt input, trusted history, a
   * per-turn reply check). Runs after `beforeTurn`, with the turn's context.
   * Request body fields are never copied into the prompt input by the route;
   * only what this callback returns is used. Return `{ error }` to refuse.
   */
  prepareTurn?: (args: {
    ctx: ExecutionContext;
    chat: ChatDefinition;
    request: FastifyRequest;
    body: ChatTurnParsedBody;
    rawBody: unknown;
    userMessage: string;
  }) => Promise<ChatPreparedTurn | { error: ChatRouteRefusal }>;
  /**
   * Validate every finished reply before it is persisted (turns and confirm
   * resumes). See `RunChatTurnOpts.validateReply`.
   */
  validateReply?: ChatReplyValidator;
  /** D3 — injected authenticator; when absent a default is derived from routeConfig.authAdapter. */
  authenticator?: ChatRequestAuthenticator;
  /** D1 — conversation store; when present the /confirm route + C5 pre-turn pending check are enabled. */
  store?: ChatConversationStore;
  /**
   * Tier-1 session/turn storage for `runChatTurn`. Supply this to serve chats from
   * a backend other than `ctx.data` — e.g. a remote memory platform reached through
   * a port. Omit it to keep the DB-backed default. Chats declaring a `budget` need a
   * store implementing `aggregateForBudget`; the mismatch is reported here at
   * registration rather than mid-conversation.
   */
  sessionStore?: ChatSessionStore;
  /** D3 — required alongside csrfSecret to enable browser Origin + CSRF enforcement on cookie auth. */
  externalBaseUrl?: string;
  /** D3 — HMAC secret for session-bound CSRF tokens. Enables browser write protection when set. */
  csrfSecret?: string;
  /**
   * Refuse to register when cookie auth is on (`authCookieNames` non-empty) but
   * browser write protection is not (`csrfSecret` or `externalBaseUrl` missing).
   * Default `true` (since 0.9): the missing settings are a startup error. Set
   * `false` only when the deployment protects cookie-authenticated writes another
   * way (e.g. a proxy); registration then logs a warning instead.
   */
  requireBrowserSecurity?: boolean;
}

class ChatUnauthorizedError extends Error {}

/**
 * Cookie credentials are sent by the browser on cross-site requests, so cookie
 * auth without Origin + CSRF enforcement leaves /turn and /confirm open to
 * cross-site writes. Throw (default) or warn (`requireBrowserSecurity: false`) at
 * registration when that is the configuration.
 */
function checkBrowserSecurityConfig(opts: RegisterChatRoutesOpts | undefined): void {
  const cookieNames = opts?.authCookieNames ?? [];
  if (cookieNames.length === 0) return;
  const missing: string[] = [];
  if (!opts?.csrfSecret) missing.push('csrfSecret');
  if (!opts?.externalBaseUrl) missing.push('externalBaseUrl');
  if (missing.length === 0) return;
  const message =
    `registerChatRoutes: cookie auth is enabled (authCookieNames) but ${missing.join(' and ')} ` +
    `${missing.length === 1 ? 'is' : 'are'} not set, so cookie-authenticated /turn and /confirm ` +
    'requests are NOT checked for Origin or CSRF. Set both csrfSecret and externalBaseUrl ' +
    'to enable browser write protection.';
  if (opts?.requireBrowserSecurity !== false) {
    throw new Error(
      `${message} Pass requireBrowserSecurity: false only if cookie-authenticated writes are protected another way.`,
    );
  }
  console.warn(
    `[registerChatRoutes] ${message} (requireBrowserSecurity: false — remove it to make this a startup error.)`,
  );
}

/**
 * C5 pending probe that never reveals another caller's pending action. The
 * scope is passed to the store (built-in stores resolve owner + chat first);
 * when a custom store ignores it, the ownership-enforced `peekPending` confirms
 * the action is the caller's before its id and expiry are returned.
 */
async function inspectOwnSession(
  store: ChatConversationStore,
  sessionId: string,
  owner: AuthContext,
  chatName: string,
): Promise<{ pending: 'none' | 'pending' | 'confirming'; actionId?: string; expiresAt?: string }> {
  const now = new Date().toISOString();
  // runChatTurn stores an anonymous caller's session under userId '' — match it.
  owner = { ...owner, userId: owner.userId ?? '' };
  const info = await store.inspectSession(sessionId, now, { owner, chatName });
  if (info.pending === 'none' || !info.actionId) return info;
  const peek = await store.peekPending({ actionId: info.actionId, owner, chatName, now });
  if (!peek.found && (peek.reason === 'not_found' || peek.reason === 'wrong_owner')) {
    return { pending: 'none' };
  }
  return info;
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const cookies = (req as { cookies?: Record<string, string> }).cookies;
  if (cookies?.[name]) return cookies[name];
  const header = req.headers.cookie;
  if (!header || typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Default authenticator: Authorization header first, then cookie fallback (parity with legacy /turn). */
function defaultAuthenticator(
  routeConfig: RouteGeneratorConfig,
  cookieNames: string[],
): ChatRequestAuthenticator {
  return {
    async authenticate(request: unknown): Promise<ChatRequestAuthentication> {
      const req = request as FastifyRequest;
      const header = req.headers.authorization;
      if (header) {
        const auth = await routeConfig.authAdapter.authenticate(header);
        if (!auth) throw new ChatUnauthorizedError();
        return { auth, credentialSource: 'authorization_header' };
      }
      for (const name of cookieNames) {
        const value = readCookie(req, name);
        if (value) {
          const auth = await routeConfig.authAdapter.authenticate(`Bearer ${value}`);
          if (!auth) throw new ChatUnauthorizedError();
          return { auth, credentialSource: 'cookie' };
        }
      }
      throw new ChatUnauthorizedError();
    },
  };
}

function csrfHeaderValue(req: FastifyRequest): string | undefined {
  const raw = req.headers[CHAT_CSRF_HEADER_NAME];
  return Array.isArray(raw) ? raw[0] : raw;
}

function buildCsrfSetCookie(token: string, secure: boolean): string {
  const base = `${CHAT_CSRF_COOKIE_NAME}=${token}; Path=/; SameSite=Strict`;
  return secure ? `${base}; Secure` : base;
}

/** D3 — cookie-authenticated writes require exact Origin + valid session-bound CSRF token. */
function enforceBrowserWrite(
  req: FastifyRequest,
  auth: AuthContext,
  credentialSource: ChatRequestAuthentication['credentialSource'],
  externalBaseUrl: string,
  csrfSecret: string,
): { ok: true } | { ok: false; code: 'chat.origin_invalid' } {
  if (credentialSource !== 'cookie') return { ok: true };
  if (!originAllowed(req.headers.origin, externalBaseUrl)) {
    return { ok: false, code: 'chat.origin_invalid' };
  }
  const binding = csrfBindingFromAuth(auth);
  const header = csrfHeaderValue(req);
  const cookie = readCookie(req, CHAT_CSRF_COOKIE_NAME);
  // Bootstrap: first cookie-authenticated write before the browser echoes Set-Cookie.
  if (!cookie && !header) return { ok: true };
  if (!verifyCsrfToken(csrfSecret, binding, header)) {
    return { ok: false, code: 'chat.origin_invalid' };
  }
  return { ok: true };
}

type SeamOutcome<T> = { ok: true; value: T } | { ok: false; refusal: ChatRouteRefusal };

function seamErrorRefusal(err: unknown): ChatRouteRefusal {
  if (isPlumbusError(err)) {
    const mapped = errorToHttpResponse(err);
    return { status: mapped.statusCode, body: mapped.body };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'Internal error' } } };
}

/** Apply `requestContext.bindTenant`; returns the caller with the bound tenant. */
async function applyTenantBinding(
  seam: ChatRequestContextSeam | undefined,
  args: ChatRequestContextArgs,
): Promise<SeamOutcome<AuthContext>> {
  if (!seam?.bindTenant) return { ok: true, value: args.auth };
  try {
    const decided = await seam.bindTenant(args);
    if ('refuse' in decided) return { ok: false, refusal: decided.refuse };
    const bound: AuthContext = { ...args.auth };
    if (decided.tenantId === undefined) delete (bound as { tenantId?: string }).tenantId;
    else bound.tenantId = decided.tenantId;
    return { ok: true, value: bound };
  } catch (err) {
    return { ok: false, refusal: seamErrorRefusal(err) };
  }
}

/** Build the request's ExecutionContext through the configured dependency path. */
async function buildRequestContext(
  routeConfig: RouteGeneratorConfig,
  seam: ChatRequestContextSeam | undefined,
  auth: AuthContext,
  chat: ChatDefinition,
  req: FastifyRequest,
): Promise<SeamOutcome<ExecutionContext>> {
  let deps: ReturnType<RouteGeneratorConfig['createDependencies']>;
  if (seam?.dependencies === 'route-config' && routeConfig.resolveDependencies) {
    try {
      const resolved = await routeConfig.resolveDependencies(auth, {
        bypassTenantScope: chat.access?.tenantScoped === false,
      });
      deps = resolved.dependencies;
    } catch (err) {
      return { ok: false, refusal: seamErrorRefusal(err) };
    }
  } else {
    deps = routeConfig.createDependencies(auth);
  }
  deps.request = {
    sourceIp: req.ip,
    userAgent: req.headers['user-agent'],
  };
  return { ok: true, value: createExecutionContext(deps) };
}

/** Apply `requestContext.checkSession`. */
async function checkSessionLive(
  seam: ChatRequestContextSeam | undefined,
  args: ChatRequestContextArgs & { ctx: ExecutionContext },
): Promise<SeamOutcome<true>> {
  if (!seam?.checkSession) return { ok: true, value: true };
  try {
    const live = await seam.checkSession(args);
    if (live === true) return { ok: true, value: true };
    return {
      ok: false,
      refusal: { status: 401, body: { error: { code: 'chat.session_not_live' } } },
    };
  } catch (err) {
    return { ok: false, refusal: seamErrorRefusal(err) };
  }
}

export function registerChatRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  chats: ChatDefinition[],
  opts?: RegisterChatRoutesOpts,
): void {
  const byName = new Map(chats.map((c) => [c.name, c]));
  const cookieNames = opts?.authCookieNames ?? [];
  const authenticator = opts?.authenticator ?? defaultAuthenticator(routeConfig, cookieNames);
  const store = opts?.store;
  checkBrowserSecurityConfig(opts);
  // Fail fast when injected storage cannot serve the registered chats (no-op
  // unless a sessionStore was injected).
  assertChatStoresSupportChats({
    chats,
    sessionStore: opts?.sessionStore,
    conversationStore: opts?.store,
  });
  const runOpts: RunChatTurnOpts = {
    sessionStore: opts?.sessionStore,
    conversationStore: opts?.store,
  };
  const browserSecurityEnabled = Boolean(opts?.csrfSecret && opts?.externalBaseUrl);
  const csrfSecret = opts?.csrfSecret ?? '';
  const externalBaseUrl = opts?.externalBaseUrl ?? '';
  const csrfSecure = externalBaseUrl.startsWith('https://');

  for (const chat of chats) {
    const expose = chat.exposeAs ?? 'sse';
    if (expose === 'capability') continue;

    const streaming = chat.streaming ?? true;

    app.post(`/chat/${chat.name}/turn`, async (req, reply) => {
      let authn: ChatRequestAuthentication;
      try {
        authn = await authenticator.authenticate(req);
      } catch {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      let auth = authn.auth;

      const parsed = turnBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
      }

      if (browserSecurityEnabled) {
        const guard = enforceBrowserWrite(
          req,
          auth,
          authn.credentialSource,
          externalBaseUrl,
          csrfSecret,
        );
        if (!guard.ok) {
          return reply.status(403).send({ error: { code: guard.code } });
        }
      }

      const seam = opts?.requestContext;
      const bound = await applyTenantBinding(seam, { request: req, auth, chat, route: 'turn' });
      if (!bound.ok) return reply.status(bound.refusal.status).send(bound.refusal.body);
      auth = bound.value;

      if (!seam?.bindTenant) {
        const overriddenTenant = opts?.audienceTenantOverride?.(parsed.data.audience, auth);
        if (overriddenTenant && !auth.tenantId) {
          auth = { ...auth, tenantId: overriddenTenant };
        }
      }

      // Legacy order (no route-config resolver): access is decided before the
      // dependencies are built. With the resolver, the resolver may bind the
      // tenant, so access is decided on the context's caller afterwards.
      const resolveFirst = seam?.dependencies === 'route-config';
      if (!resolveFirst) {
        const authz = evaluateAccess(chat.access, auth);
        if (!authz.allowed) {
          return reply.status(403).send({
            error: { code: 'forbidden', message: authz.reason ?? 'Access denied' },
          });
        }
      }

      try {
        validateClientHistorySize(parsed.data.clientHistory);
      } catch {
        return reply.status(400).send({ error: { code: 'chat.client_history_too_large' } });
      }

      const built = await buildRequestContext(routeConfig, seam, auth, chat, req);
      if (!built.ok) return reply.status(built.refusal.status).send(built.refusal.body);
      const ctx = built.value;
      if (resolveFirst) {
        auth = ctx.auth;
        const authz = evaluateAccess(chat.access, auth);
        if (!authz.allowed) {
          return reply.status(403).send({
            error: { code: 'forbidden', message: authz.reason ?? 'Access denied' },
          });
        }
      }

      const live = await checkSessionLive(seam, { request: req, auth, chat, route: 'turn', ctx });
      if (!live.ok) return reply.status(live.refusal.status).send(live.refusal.body);

      // C5 — check live pending BEFORE scope/provider work.
      if (store) {
        const info = await inspectOwnSession(store, parsed.data.sessionId, auth, chat.name);
        if (info.pending === 'confirming') {
          return reply.status(409).send({
            code: 'chat.session_busy',
            actionId: info.actionId,
            expiresAt: info.expiresAt,
          });
        }
        if (info.pending === 'pending') {
          return reply.status(409).send({
            code: 'chat.pending_action_exists',
            actionId: info.actionId,
            expiresAt: info.expiresAt,
          });
        }
      } else if (
        // Skipped for a tier-1-only deployment: no conversation store means no
        // pending action can exist (runChatTurn refuses confirmations, and startup
        // validation rejects chats that could raise them), and checkLivePending
        // reads ctx.data — the very thing an injected session store exists to avoid.
        !opts?.sessionStore &&
        (chat.persistence?.saveToDb ?? true) &&
        (chat.persistence?.messageContent ?? 'server') !== 'client'
      ) {
        const live = await checkLivePending(ctx, parsed.data.sessionId, {
          userId: auth.userId ?? '',
          chatName: chat.name,
        });
        if (live.blocked) {
          return reply
            .status(409)
            .send({ code: live.code, actionId: live.actionId, expiresAt: live.expiresAt });
        }
      }

      let effectiveUserMessage = parsed.data.userMessage;
      if (opts?.beforeTurn) {
        const result = await opts.beforeTurn(ctx, parsed.data, req.body);
        if ('error' in result) {
          return reply.status(result.error.status).send(result.error.body);
        }
        if (result.userMessage !== undefined) {
          effectiveUserMessage = result.userMessage;
        }
      }

      const definition = byName.get(chat.name);
      if (!definition) {
        if (!streaming) {
          return reply.status(404).send({
            events: [{ type: 'turn.failed', code: 'chat.not_found', message: 'Chat not found' }],
          });
        }
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'turn.failed', code: 'chat.not_found', message: 'Chat not found' })}\n\n`,
        );
        reply.raw.end();
        return;
      }

      let prepared: ChatPreparedTurn = {};
      if (opts?.prepareTurn) {
        const result = await opts.prepareTurn({
          ctx,
          chat: definition,
          request: req,
          body: parsed.data,
          rawBody: req.body,
          userMessage: effectiveUserMessage,
        });
        if ('error' in result) {
          return reply.status(result.error.status).send(result.error.body);
        }
        prepared = result;
      }

      const runArgs = {
        chatDefinition: definition,
        sessionId: parsed.data.sessionId,
        userMessage: effectiveUserMessage,
        audience: parsed.data.audience,
        locale: parsed.data.locale,
        clientHistory: capClientHistory(parsed.data.clientHistory),
        registry: opts?.chatRegistry,
        ...(prepared.promptInput ? { promptInput: prepared.promptInput } : {}),
        ...(prepared.trustedHistory ? { trustedHistory: prepared.trustedHistory } : {}),
      };
      const validateReply = prepared.validateReply ?? opts?.validateReply;
      const turnOpts: RunChatTurnOpts = validateReply ? { ...runOpts, validateReply } : runOpts;

      const csrfCookie = browserSecurityEnabled
        ? buildCsrfSetCookie(issueCsrfToken(csrfSecret, csrfBindingFromAuth(auth)), csrfSecure)
        : undefined;

      if (!streaming) {
        const events: ChatEvent[] = [];
        for await (const evt of runChatTurn(ctx, runArgs, turnOpts)) {
          events.push(evt);
        }
        if (opts?.afterTurn) {
          try {
            await opts.afterTurn(ctx, req.body, events);
          } catch (err) {
            console.warn('[registerChatRoutes] afterTurn hook failed:', err);
          }
        }
        if (csrfCookie) reply.header('set-cookie', csrfCookie);
        return reply.send({ events });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(csrfCookie ? { 'Set-Cookie': csrfCookie } : {}),
      });

      const events: ChatEvent[] = [];
      for await (const evt of runChatTurn(ctx, runArgs, turnOpts)) {
        events.push(evt);
        reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      reply.raw.end();

      if (opts?.afterTurn) {
        try {
          await opts.afterTurn(ctx, req.body, events);
        } catch (err) {
          console.warn('[registerChatRoutes] afterTurn hook failed:', err);
        }
      }
    });

    // POST /chat/:name/confirm — only wired when a conversation store is supplied (D1).
    if (store) {
      app.post(`/chat/${chat.name}/confirm`, async (req, reply) => {
        await handleConfirm(req, reply, {
          chat,
          streaming,
          routeConfig,
          authenticator,
          store,
          browserSecurityEnabled,
          externalBaseUrl,
          csrfSecret,
          csrfSecure,
          opts,
        });
      });
    }
  }
}

interface ConfirmDeps {
  chat: ChatDefinition;
  streaming: boolean;
  routeConfig: RouteGeneratorConfig;
  authenticator: ChatRequestAuthenticator;
  store: ChatConversationStore;
  browserSecurityEnabled: boolean;
  externalBaseUrl: string;
  csrfSecret: string;
  csrfSecure: boolean;
  opts?: RegisterChatRoutesOpts;
}

async function handleConfirm(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ConfirmDeps,
): Promise<void> {
  const { chat, streaming, routeConfig, authenticator, store } = deps;

  let authn: ChatRequestAuthentication;
  try {
    authn = await authenticator.authenticate(req);
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  let auth = authn.auth;

  const parsed = confirmBodySchema.safeParse(req.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }

  if (deps.browserSecurityEnabled) {
    const guard = enforceBrowserWrite(
      req,
      auth,
      authn.credentialSource,
      deps.externalBaseUrl,
      deps.csrfSecret,
    );
    if (!guard.ok) {
      reply.status(403).send({ error: { code: guard.code } });
      return;
    }
  }

  const seam = deps.opts?.requestContext;
  const bound = await applyTenantBinding(seam, { request: req, auth, chat, route: 'confirm' });
  if (!bound.ok) {
    reply.status(bound.refusal.status).send(bound.refusal.body);
    return;
  }
  auth = bound.value;

  const resolveFirst = seam?.dependencies === 'route-config';
  const denyIfNoAccess = (): boolean => {
    const authz = evaluateAccess(chat.access, auth);
    if (authz.allowed) return false;
    reply.status(403).send({
      error: { code: 'forbidden', message: authz.reason ?? 'Access denied' },
    });
    return true;
  };
  if (!resolveFirst && denyIfNoAccess()) return;

  const { actionId, inputSchemaHash, decision } = parsed.data;
  const now = new Date().toISOString();

  const built = await buildRequestContext(routeConfig, seam, auth, chat, req);
  if (!built.ok) {
    reply.status(built.refusal.status).send(built.refusal.body);
    return;
  }
  const ctx = built.value;
  if (resolveFirst) {
    auth = ctx.auth;
    if (denyIfNoAccess()) return;
  }
  const live = await checkSessionLive(seam, { request: req, auth, chat, route: 'confirm', ctx });
  if (!live.ok) {
    reply.status(live.refusal.status).send(live.refusal.body);
    return;
  }

  const csrfCookie = deps.browserSecurityEnabled
    ? buildCsrfSetCookie(
        issueCsrfToken(deps.csrfSecret, csrfBindingFromAuth(auth)),
        deps.csrfSecure,
      )
    : undefined;

  // ── Decision: reject (no resume; JSON response). ──
  if (decision === 'reject') {
    const rej = await store.rejectPending({ actionId, owner: auth, chatName: chat.name, now });
    if (rej.outcome === 'not_found') {
      reply.status(404).send({ code: 'chat.action_not_found', actionId });
      return;
    }
    if (rej.outcome === 'already_claimed') {
      reply.status(409).send({ code: 'chat.session_busy', actionId });
      return;
    }
    if (rej.outcome === 'expired') {
      reply.status(410).send({ code: 'chat.action_expired', actionId });
      return;
    }
    await ctx.events.emit(chatActionRejectedEvent.name, {
      actionId,
      capabilityName: rej.capabilityName,
    });
    const evt: ChatEvent = {
      type: 'confirmation.resolved',
      actionId,
      decision: 'reject',
      pendingStatus: 'rejected',
      executionStatus: 'not_requested',
    };
    const result: ChatConfirmResult = {
      decisionRecorded: true,
      pendingStatus: 'rejected',
      execution: { status: 'not_requested' },
      resume: { status: 'not_requested' },
    };
    if (csrfCookie) reply.header('set-cookie', csrfCookie);
    reply.status(200).send({ events: [evt], result });
    return;
  }

  // ── Decision: confirm. Peek → recompute binding → claim (all pre-stream, C8 status). ──
  const peek = await store.peekPending({ actionId, owner: auth, chatName: chat.name, now });
  if (!peek.found) {
    if (peek.reason === 'expired') {
      reply.status(410).send({ code: 'chat.action_expired', actionId });
    } else {
      reply.status(404).send({ code: 'chat.action_not_found', actionId });
    }
    return;
  }
  const pendingRow: ChatPendingActionV2 = peek.pending;
  const kind = pendingRow.capabilityName.startsWith('flow__') ? 'flow' : 'capability';

  const binding = await resolveToolBinding(ctx, kind, pendingRow.capabilityName);
  if (!binding.ok) {
    reply
      .status(409)
      .send({ code: 'chat.binding_changed', actionId, expiresAt: pendingRow.expiresAt });
    return;
  }
  // Client-echoed hash must match the current binding (drift-from-client check).
  if (inputSchemaHash !== binding.inputSchemaHash) {
    reply
      .status(409)
      .send({ code: 'chat.binding_changed', actionId, expiresAt: pendingRow.expiresAt });
    return;
  }

  const claim = await store.claimPending({
    actionId,
    owner: auth,
    chatName: chat.name,
    inputSchemaHash: binding.inputSchemaHash,
    toolBindingHash: binding.toolBindingHash,
    attemptId: crypto.randomUUID(),
    now,
  });
  if (claim.outcome === 'not_found') {
    reply.status(404).send({ code: 'chat.action_not_found', actionId });
    return;
  }
  if (claim.outcome === 'already_claimed') {
    reply
      .status(409)
      .send({ code: 'chat.action_already_claimed', actionId, expiresAt: pendingRow.expiresAt });
    return;
  }
  if (claim.outcome === 'expired') {
    reply.status(410).send({ code: 'chat.action_expired', actionId });
    return;
  }
  if (claim.outcome === 'stale') {
    reply
      .status(409)
      .send({ code: 'chat.confirm_stale', actionId, expiresAt: pendingRow.expiresAt });
    return;
  }
  if (claim.outcome === 'binding_changed') {
    reply
      .status(409)
      .send({ code: 'chat.binding_changed', actionId, expiresAt: pendingRow.expiresAt });
    return;
  }

  // Claimed → open the stream (SSE or JSON) and run the resume orchestration.
  const claimedPending = claim.pending;
  const perTurnSeconds = chat.budget?.timeout?.perTurnSeconds ?? 120;
  const signal = AbortSignal.timeout(perTurnSeconds * 1000);

  const events: ChatEvent[] = [];
  let confirmResult: ChatConfirmResult | undefined;

  if (streaming) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(csrfCookie ? { 'Set-Cookie': csrfCookie } : {}),
    });
    const emit = (evt: ChatEvent): void => {
      events.push(evt);
      reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    await resumeAfterConfirm(ctx, {
      chat,
      store,
      pending: claimedPending,
      owner: auth,
      emit,
      onResult: (r) => {
        confirmResult = r;
      },
      signal,
      validateReply: deps.opts?.validateReply,
    });
    reply.raw.end();
    return;
  }

  const emit = (evt: ChatEvent): void => {
    events.push(evt);
  };
  await resumeAfterConfirm(ctx, {
    chat,
    store,
    pending: claimedPending,
    owner: auth,
    emit,
    onResult: (r) => {
      confirmResult = r;
    },
    signal,
    validateReply: deps.opts?.validateReply,
  });
  if (csrfCookie) reply.header('set-cookie', csrfCookie);
  reply.status(200).send({ events, result: confirmResult });
}
