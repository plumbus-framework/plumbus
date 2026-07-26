import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseCookieHeader } from '@plumbus/core';
import type { NormalizedAuthRuntimeConfig } from '../config/types.js';
import type { ProviderAvailabilityMap } from '../providers/availability.js';
import type { DiscoveredProvider } from '../providers/discovery.js';
import { splitLoginQuery, type createLoginFlow } from '../flow/login-flow.js';
import type { SessionManager } from '../sessions/manager.js';
import { readSessionCookie, buildClearSessionCookieHeader } from '../sessions/cookie.js';
import { errorRedirectUrl, mapCallbackError, SECURITY_HEADERS } from './responses.js';
import { randomToken } from '../crypto/random.js';

export interface AuthRouteDeps {
  config: NormalizedAuthRuntimeConfig;
  availability: ProviderAvailabilityMap;
  getDiscovered(providerId: string): DiscoveredProvider | undefined;
  loginFlow: ReturnType<typeof createLoginFlow>;
  sessions: SessionManager;
  resolveClientSecret(providerId: string): Promise<string>;
  emitAudit?: (event: string, metadata?: Record<string, unknown>) => void;
  clock?: () => Date;
}

function applySecurityHeaders(reply: FastifyReply): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    reply.header(key, value);
  }
}

function parseCookies(req: FastifyRequest): Record<string, string> {
  const header = req.headers.cookie;
  return typeof header === 'string' ? parseCookieHeader(header) : {};
}

function providerParam(req: FastifyRequest): string | undefined {
  const params = req.params as { provider?: string };
  return params.provider;
}

function callbackLogPath(base: string, providerId: string): string {
  return `${base}/callback/${providerId}`;
}

function replyLoginStartError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof Error && error.message === 'provider_unavailable') {
    return reply.code(503).send({ error: 'provider_unavailable' });
  }
  if (error instanceof Error && error.message === 'login_context_unavailable') {
    return reply.code(503).send({ error: 'login_unavailable' });
  }
  return reply.code(400).send({ error: 'invalid_request' });
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config } = deps;
  const nowFn = deps.clock ?? (() => new Date());
  const base = config.basePath;

  app.get(`${base}/providers`, async (_req, reply) => {
    applySecurityHeaders(reply);
    const providers = Object.entries(config.providers)
      .filter(([, reg]) => reg.discoverable)
      .map(([id, reg]) => ({
        id,
        label: reg.display?.label ?? id,
        loginUrl: `${base}/login/${id}`,
        available: deps.availability.get(id) === 'available',
      }));
    return reply.send({ providers });
  });

  app.get(`${base}/login`, async (req, reply) => {
    applySecurityHeaders(reply);
    if (!config.defaultProvider) {
      return reply.code(404).send({ error: 'no_default_provider' });
    }
    const split = splitLoginQuery(
      req.query as Record<string, string | undefined>,
      config.loginContext?.params ?? [],
    );
    try {
      const result = await deps.loginFlow.startLogin({
        providerId: config.defaultProvider,
        returnTo: split.returnTo,
        query: {},
        contextParams: split.contextParams,
        cookies: parseCookies(req),
      });
      if (result.bindingCookie) {
        reply.header('Set-Cookie', result.bindingCookie);
      }
      deps.emitAudit?.('auth.login.started', { providerId: config.defaultProvider });
      return reply.redirect(result.redirectUrl);
    } catch (error) {
      return replyLoginStartError(reply, error);
    }
  });

  app.get(`${base}/login/:provider`, async (req, reply) => {
    applySecurityHeaders(reply);
    const providerId = providerParam(req);
    if (!providerId || !config.providers[providerId]) {
      return reply.code(404).send({ error: 'unknown_provider' });
    }
    const split = splitLoginQuery(
      req.query as Record<string, string | undefined>,
      config.loginContext?.params ?? [],
    );
    try {
      const result = await deps.loginFlow.startLogin({
        providerId,
        returnTo: split.returnTo,
        query: split.providerParams,
        contextParams: split.contextParams,
        cookies: parseCookies(req),
      });
      if (result.bindingCookie) {
        reply.header('Set-Cookie', result.bindingCookie);
      }
      deps.emitAudit?.('auth.login.started', { providerId });
      return reply.redirect(result.redirectUrl);
    } catch (error) {
      return replyLoginStartError(reply, error);
    }
  });

  app.get(`${base}/callback/:provider`, async (req, reply) => {
    applySecurityHeaders(reply);
    const providerId = providerParam(req);
    if (!providerId || !config.providers[providerId]) {
      return reply.code(400).send({ error: 'unknown_provider' });
    }
    req.log.info({ path: callbackLogPath(base, providerId) }, 'auth callback');
    const requestId = randomToken();
    try {
      const url = new URL(req.url, config.externalBaseUrl);
      const result = await deps.loginFlow.handleCallback({
        providerId,
        query: url.searchParams,
        cookies: parseCookies(req),
      });
      reply.header('Set-Cookie', result.setCookie);
      deps.emitAudit?.('auth.login.succeeded', { providerId, requestId });
      return reply.redirect(result.returnTo, 303);
    } catch (error) {
      const code = mapCallbackError(error);
      if (error instanceof Error && error.message === 'login_cancelled') {
        deps.emitAudit?.('auth.login.cancelled', { providerId, requestId });
      } else if (error instanceof Error && error.message === 'login_denied') {
        deps.emitAudit?.('auth.login.denied', { providerId, requestId });
      } else {
        deps.emitAudit?.('auth.login.failed', { providerId, requestId });
      }
      return reply.redirect(errorRedirectUrl(config.errorPath, code, requestId), 303);
    }
  });

  app.get(`${base}/session`, async (req, reply) => {
    applySecurityHeaders(reply);
    const cookies = parseCookies(req);
    const cookieValue = readSessionCookie(cookies, config.session.cookieName);
    const authResult = await deps.sessions.authenticateSession({
      cookies,
      method: 'GET',
      now: nowFn(),
    });
    if (authResult.status === 'unavailable') {
      return reply.code(503).send({ error: 'authentication_unavailable' });
    }
    if (authResult.status !== 'authenticated') {
      if (authResult.status === 'anonymous' && authResult.clearCookieHeader) {
        reply.header('Set-Cookie', authResult.clearCookieHeader);
      }
      return reply.send({ authenticated: false });
    }
    const csrfToken = await deps.sessions.getCsrfForCookie(cookieValue, nowFn());
    const expiresAt = await deps.sessions.getSessionExpiry(cookieValue, nowFn());
    return reply.send({
      authenticated: true,
      user: {
        userId: authResult.auth.userId,
        roles: authResult.auth.roles,
        scopes: authResult.auth.scopes,
        tenantId: authResult.auth.tenantId,
        provider: authResult.auth.provider,
        providerId: authResult.auth.providerId,
        authenticatedAt: authResult.auth.authenticatedAt?.toISOString(),
      },
      csrfToken,
      expiresAt: (expiresAt ?? authResult.auth.authenticatedAt ?? new Date()).toISOString(),
    });
  });

  app.post(`${base}/logout`, async (req, reply) => {
    applySecurityHeaders(reply);
    const cookies = parseCookies(req);
    const logout = await deps.sessions.prepareLogout({
      cookies,
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      csrfToken:
        typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
      now: nowFn(),
    });
    if (logout.status === 'csrf_failed') {
      return reply.code(403).send({ error: 'csrf_failed' });
    }

    const cookieValue = readSessionCookie(cookies, config.session.cookieName);
    await deps.sessions.deleteSession(logout.cookieValue ?? cookieValue);
    reply.header('Set-Cookie', buildClearSessionCookieHeader(config));
    deps.emitAudit?.('auth.logout', {});

    let providerLogoutUrl: string | undefined;
    if (logout.hadLiveSession && logout.providerId) {
      const reg = config.providers[logout.providerId];
      const discovered = deps.getDiscovered(logout.providerId);
      if (reg?.providerLogout && discovered) {
        const built = reg.integration?.buildProviderLogoutUrl?.({
          metadata: { endSessionEndpoint: discovered.metadata.endSessionEndpoint },
          clientId: reg.clientId,
          logoutUri: new URL(reg.providerLogout.returnTo, config.applicationBaseUrl).toString(),
        });
        if (built) {
          providerLogoutUrl = built.toString();
        }
      }
    }

    return reply.send({
      loggedOut: true,
      ...(providerLogoutUrl ? { providerLogoutUrl } : {}),
    });
  });
}
