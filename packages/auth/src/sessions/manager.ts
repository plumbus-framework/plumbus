import type { AuthContext, AuthenticationResult, RequestAuthenticator } from '@plumbus/core';
import { executeResolveAuthorization } from '../resolvers/execute.js';
import type { SessionPrincipal } from '../resolvers/types.js';
import type { NormalizedAuthRuntimeConfig } from '../config/types.js';
import type { StorageProtection } from '../crypto/protection.js';
import { randomToken } from '../crypto/random.js';
import type { SessionStore } from '../stores/types.js';
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  originMatchesApplication,
  parseOrigin,
  readSessionCookie,
  verifyCsrfToken,
} from './cookie.js';

interface SessionPrincipalPayload {
  userId: string;
  providerId: string;
  issuer: string;
  subject: string;
  csrfToken: string;
  acr?: string;
  amr?: readonly string[];
  providerAuthenticatedAt?: string;
}

export interface SessionManager {
  createSession(input: {
    userId: string;
    providerId: string;
    issuer: string;
    subject: string;
    acr?: string;
    amr?: readonly string[];
    providerAuthenticatedAt?: Date;
    now: Date;
  }): Promise<{ cookieValue: string; setCookie: string; sessionRef: string }>;
  authenticateSession(input: {
    cookies: Readonly<Record<string, string>>;
    method: string;
    origin?: string;
    csrfToken?: string;
    now: Date;
  }): Promise<AuthenticationResult>;
  deleteSession(cookieValue: string | undefined): Promise<void>;
  getCsrfForCookie(cookieValue: string | undefined, now: Date): Promise<string | null>;
  getSessionExpiry(cookieValue: string | undefined, now: Date): Promise<Date | null>;
  prepareLogout(input: {
    cookies: Readonly<Record<string, string>>;
    origin?: string;
    csrfToken?: string;
    now: Date;
  }): Promise<
    | { status: 'csrf_failed' }
    | { status: 'ok'; hadLiveSession: boolean; providerId?: string; cookieValue?: string }
  >;
}

export function createSessionManager(opts: {
  config: NormalizedAuthRuntimeConfig;
  store: SessionStore;
  protection: StorageProtection;
  clock?: () => Date;
  onSessionEvicted?: (count: number) => void;
}): SessionManager {
  const { config, store, protection } = opts;

  async function loadRecord(cookieValue: string) {
    return store.getByIdHash({
      applicationId: config.applicationId,
      sessionIdHash: protection.hmac('session-id-hmac', cookieValue),
    });
  }

  return {
    async createSession(input) {
      const cookieValue = randomToken();
      const sessionRef = randomToken();
      const csrfToken = randomToken();
      const principal: SessionPrincipalPayload = {
        userId: input.userId,
        providerId: input.providerId,
        issuer: input.issuer,
        subject: input.subject,
        csrfToken,
        acr: input.acr,
        amr: input.amr,
        providerAuthenticatedAt: input.providerAuthenticatedAt?.toISOString(),
      };
      const principalEnvelope = protection.sealJson('session-principal', 1, sessionRef, principal);
      const record = {
        applicationId: config.applicationId,
        sessionRef,
        sessionIdHash: protection.hmac('session-id-hmac', cookieValue),
        userLookup: protection.hmac('user-lookup-hmac', input.userId),
        principalEnvelope,
        csrfHash: protection.hmac('csrf-hmac', csrfToken),
        schemaVersion: 1,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + config.session.ttlMs),
      };
      let evicted = 0;
      if (store.createWithSessionCap) {
        evicted = await store.createWithSessionCap(record, config.session.maxSessionsPerUser);
      } else {
        await store.create(record);
        evicted = await store.evictOldestForUser({
          applicationId: config.applicationId,
          userLookup: record.userLookup,
          keep: config.session.maxSessionsPerUser,
        });
      }
      if (evicted > 0) {
        opts.onSessionEvicted?.(evicted);
      }
      const maxAgeSeconds = Math.ceil(config.session.ttlMs / 1000);
      return {
        cookieValue,
        setCookie: buildSessionCookieHeader(config, cookieValue, maxAgeSeconds),
        sessionRef,
      };
    },

    async authenticateSession(input) {
      const cookieValue = readSessionCookie(input.cookies, config.session.cookieName);
      if (!cookieValue) {
        return { status: 'anonymous' };
      }

      const clearHeader = buildClearSessionCookieHeader(config);
      const record = await loadRecord(cookieValue);
      if (!record) {
        return { status: 'anonymous', clearSessionCookie: true, clearCookieHeader: clearHeader };
      }
      if (input.now >= record.expiresAt) {
        await store.deleteByIdHash({
          applicationId: config.applicationId,
          sessionIdHash: record.sessionIdHash,
        });
        return { status: 'anonymous', clearSessionCookie: true, clearCookieHeader: clearHeader };
      }

      let principalPayload: SessionPrincipalPayload;
      try {
        principalPayload = protection.openJson(
          'session-principal',
          1,
          record.sessionRef,
          record.principalEnvelope,
        ) as SessionPrincipalPayload;
      } catch {
        return { status: 'unavailable', code: 'authentication_unavailable' };
      }

      const principal: SessionPrincipal = {
        userId: principalPayload.userId,
        providerId: principalPayload.providerId,
        issuer: principalPayload.issuer,
        subject: principalPayload.subject,
        sessionRef: record.sessionRef,
        authenticatedAt: record.createdAt,
        acr: principalPayload.acr,
        amr: principalPayload.amr,
      };

      const authResult = await executeResolveAuthorization(
        config.resolveAuthorization,
        principal,
        config.resolverTimeoutMs,
        { maxRoles: config.maxRoles, maxScopes: config.maxScopes },
      );

      if (authResult.status === 'temporary') {
        return { status: 'unavailable', code: 'authentication_unavailable' };
      }
      if (authResult.status === 'revoked') {
        await store.deleteByIdHash({
          applicationId: config.applicationId,
          sessionIdHash: record.sessionIdHash,
        });
        return { status: 'anonymous', clearSessionCookie: true, clearCookieHeader: clearHeader };
      }

      const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method.toUpperCase());
      if (unsafe) {
        const origin = parseOrigin(input.origin);
        if (!origin || !originMatchesApplication(origin, config.applicationBaseUrl)) {
          return { status: 'invalid', code: 'csrf_failed' };
        }
        const csrfValid = verifyCsrfToken(
          (value) => protection.hmac('csrf-hmac', value),
          record.csrfHash,
          input.csrfToken,
        );
        if (!csrfValid) {
          return { status: 'invalid', code: 'csrf_failed' };
        }
      }

      const auth: AuthContext = {
        userId: principal.userId,
        roles: authResult.roles,
        scopes: authResult.scopes,
        tenantId: authResult.tenantId,
        provider: 'oidc',
        providerId: principal.providerId,
        sessionId: record.sessionRef,
        authenticatedAt: record.createdAt,
      };
      return { status: 'authenticated', auth };
    },

    async deleteSession(cookieValue) {
      if (!cookieValue) return;
      await store.deleteByIdHash({
        applicationId: config.applicationId,
        sessionIdHash: protection.hmac('session-id-hmac', cookieValue),
      });
    },

    async getCsrfForCookie(cookieValue, now) {
      if (!cookieValue) return null;
      const record = await loadRecord(cookieValue);
      if (!record || now >= record.expiresAt) return null;
      try {
        const principalPayload = protection.openJson(
          'session-principal',
          1,
          record.sessionRef,
          record.principalEnvelope,
        ) as SessionPrincipalPayload;
        return principalPayload.csrfToken;
      } catch {
        return null;
      }
    },

    async getSessionExpiry(cookieValue, now) {
      if (!cookieValue) return null;
      const record = await loadRecord(cookieValue);
      if (!record || now >= record.expiresAt) return null;
      return record.expiresAt;
    },

    async prepareLogout(input) {
      const cookieValue = readSessionCookie(input.cookies, config.session.cookieName);
      if (!cookieValue) {
        return { status: 'ok', hadLiveSession: false };
      }

      const record = await loadRecord(cookieValue);
      if (!record || input.now >= record.expiresAt) {
        return { status: 'ok', hadLiveSession: false, cookieValue };
      }

      const origin = parseOrigin(input.origin);
      if (!origin || !originMatchesApplication(origin, config.applicationBaseUrl)) {
        return { status: 'csrf_failed' };
      }
      const csrfValid = verifyCsrfToken(
        (value) => protection.hmac('csrf-hmac', value),
        record.csrfHash,
        input.csrfToken,
      );
      if (!csrfValid) {
        return { status: 'csrf_failed' };
      }

      let providerId: string | undefined;
      try {
        const principalPayload = protection.openJson(
          'session-principal',
          1,
          record.sessionRef,
          record.principalEnvelope,
        ) as SessionPrincipalPayload;
        providerId = principalPayload.providerId;
      } catch {
        providerId = undefined;
      }

      return { status: 'ok', hadLiveSession: true, providerId, cookieValue };
    },
  };
}

export function createSessionAuthenticator(
  sessionManager: SessionManager,
  clock?: () => Date,
): RequestAuthenticator {
  const nowFn = clock ?? (() => new Date());
  return {
    async authenticate(request) {
      return sessionManager.authenticateSession({
        cookies: request.cookies,
        method: request.method,
        origin: request.origin,
        csrfToken: request.csrfToken,
        now: nowFn(),
      });
    },
  };
}
