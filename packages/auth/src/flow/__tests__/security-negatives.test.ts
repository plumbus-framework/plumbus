import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { HttpAuthenticationRuntime } from '@plumbus/core';
import { createStorageProtection } from '../../crypto/protection.js';
import { createAuthRuntime, type CreateAuthRuntimeOptions } from '../../runtime/create-runtime.js';
import {
  createMemoryLoginTransactionStore,
  createMemorySessionStore,
} from '../../stores/memory.js';
import type { LoginTransactionStore, SessionStore } from '../../stores/types.js';
import { startFakeOidcProvider } from '../../testing/fake-oidc-provider.js';
import { validateReturnTo } from '../login-flow.js';
import type { ResolveAuthorization } from '../../resolvers/types.js';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EXTERNAL = 'http://127.0.0.1:3000';
const APP_ORIGIN = 'http://127.0.0.1:5173';

interface TestHarness {
  app: ReturnType<typeof Fastify>;
  fake: Awaited<ReturnType<typeof startFakeOidcProvider>>;
  runtime: HttpAuthenticationRuntime;
  sessionStore: SessionStore;
  transactionStore: LoginTransactionStore;
  close(): Promise<void>;
}

async function createHarness(
  overrides: {
    resolveAuthorization?: ResolveAuthorization;
    fakeOpts?: Parameters<typeof startFakeOidcProvider>[0];
    providerIssuer?: string;
    environment?: 'development' | 'production' | 'test';
  } = {},
  runtimeOpts?: CreateAuthRuntimeOptions,
): Promise<TestHarness> {
  const fake = await startFakeOidcProvider(overrides.fakeOpts);
  const app = Fastify();
  const sessionStore = createMemorySessionStore();
  const transactionStore = createMemoryLoginTransactionStore();
  const runtime = createAuthRuntime(
    {
      applicationId: 'app1',
      externalBaseUrl: EXTERNAL,
      applicationBaseUrl: APP_ORIGIN,
      defaultReturnPath: '/',
      errorPath: '/login/error',
      environment: overrides.environment ?? 'development',
      session: { ttl: '1h' },
      providers: {
        test: {
          type: 'oidc',
          issuer: overrides.providerIssuer ?? fake.issuer,
          clientId: 'test-client',
          clientSecret: 'test-secret',
          scopes: ['openid'],
          discoverable: true,
          display: { label: 'Test' },
        },
      },
      sessionStore,
      transactionStore,
      storageProtection: { activeKey: { id: 'k1', value: TEST_KEY } },
      resolveIdentity: async () => ({ status: 'admitted', userId: 'user-1' }),
      resolveAuthorization:
        overrides.resolveAuthorization ??
        (async () => ({ status: 'authorized', roles: [], scopes: [] })),
      deployment: { assumeSameSite: true },
    },
    runtimeOpts,
  );
  await runtime.initialize();
  runtime.registerRoutes(app);
  await app.ready();
  return {
    app,
    fake,
    runtime,
    sessionStore,
    transactionStore,
    close: async () => {
      await app.close();
      await fake.close();
    },
  };
}

async function completeLogin(app: ReturnType<typeof Fastify>) {
  const loginRes = await app.inject({ method: 'GET', url: '/auth/login/test?returnTo=/' });
  const binding = loginRes.headers['set-cookie'] ?? '';
  const providerRes = await fetch(loginRes.headers.location ?? '', { redirect: 'manual' });
  const callbackLocation = new URL(providerRes.headers.get('location') ?? '');
  const callbackPath = `${callbackLocation.pathname}${callbackLocation.search}`;
  const callbackRes = await app.inject({
    method: 'GET',
    url: callbackPath,
    headers: { cookie: binding },
  });
  const sessionCookie = String(callbackRes.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  return { binding, callbackPath, callbackRes, sessionCookie };
}

async function csrfForSessionCookie(
  harness: TestHarness,
  sessionCookieHeader: string,
): Promise<string> {
  const cookieValue = decodeURIComponent(sessionCookieHeader.split('=')[1] ?? '');
  const protection = await createStorageProtection(
    { activeKey: { id: 'k1', value: TEST_KEY } },
    { applicationId: 'app1', environment: 'development' },
  );
  const sessionIdHash = protection.hmac('session-id-hmac', cookieValue);
  const record = await harness.sessionStore.getByIdHash({
    applicationId: 'app1',
    sessionIdHash,
  });
  if (!record) {
    throw new Error('session record missing');
  }
  const principal = protection.openJson(
    'session-principal',
    1,
    record.sessionRef,
    record.principalEnvelope,
  ) as { csrfToken: string };
  return principal.csrfToken;
}

describe('§25.2 security negatives', () => {
  describe('returnTo validation', () => {
    it('rejects open redirects via control characters after decode', () => {
      expect(() => validateReturnTo('/%09/evil', '/', new URL(`${APP_ORIGIN}/app`))).toThrow(
        /invalid returnTo/,
      );
    });

    it('rejects return paths outside the application base path', () => {
      expect(() => validateReturnTo('/outside', '/', new URL(`${APP_ORIGIN}/app`))).toThrow(
        /invalid returnTo/,
      );
    });
  });

  describe('callback and login flow', () => {
    let harness: TestHarness;

    beforeAll(async () => {
      harness = await createHarness();
    });
    afterAll(async () => {
      await harness.close();
    });

    it('rejects front-channel token parameters on callback', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/auth/callback/test?id_token=leaked&state=x',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toContain('code=login_failed');
    });

    it('rejects reused callback codes', async () => {
      const first = await completeLogin(harness.app);
      expect(first.callbackRes.statusCode).toBe(303);
      const replay = await harness.app.inject({
        method: 'GET',
        url: first.callbackPath,
        headers: { cookie: first.binding },
      });
      expect(replay.statusCode).toBe(303);
      expect(replay.headers.location).toContain('code=login_failed');
    });

    it('rejects callback without browser binding cookie', async () => {
      const loginRes = await harness.app.inject({ method: 'GET', url: '/auth/login/test' });
      const providerRes = await fetch(loginRes.headers.location ?? '', { redirect: 'manual' });
      const callbackLocation = new URL(providerRes.headers.get('location') ?? '');
      const callbackRes = await harness.app.inject({
        method: 'GET',
        url: `${callbackLocation.pathname}${callbackLocation.search}`,
      });
      expect(callbackRes.statusCode).toBe(303);
      expect(callbackRes.headers.location).toContain('code=login_failed');
    });
  });

  describe('provider token validation', () => {
    it('rejects UserInfo subject mismatch', async () => {
      const fake = await startFakeOidcProvider({ userinfoSubOverride: 'other-subject' });
      const app = Fastify();
      const runtime = createAuthRuntime({
        applicationId: 'app1',
        externalBaseUrl: EXTERNAL,
        applicationBaseUrl: APP_ORIGIN,
        defaultReturnPath: '/',
        errorPath: '/login/error',
        environment: 'development',
        session: { ttl: '1h' },
        providers: {
          test: {
            type: 'oidc',
            issuer: fake.issuer,
            clientId: 'test-client',
            clientSecret: 'test-secret',
            scopes: ['openid'],
            fetchUserInfo: true,
          },
        },
        sessionStore: createMemorySessionStore(),
        transactionStore: createMemoryLoginTransactionStore(),
        storageProtection: { activeKey: { id: 'k1', value: TEST_KEY } },
        resolveIdentity: async () => ({ status: 'admitted', userId: 'user-1' }),
        resolveAuthorization: async () => ({ status: 'authorized', roles: [], scopes: [] }),
        deployment: { assumeSameSite: true },
      });
      await runtime.initialize();
      runtime.registerRoutes(app);
      await app.ready();
      try {
        const result = await completeLogin(app);
        expect(result.callbackRes.statusCode).toBe(303);
        expect(result.callbackRes.headers.location).toContain('code=login_failed');
      } finally {
        await app.close();
        await fake.close();
      }
    });
  });

  describe('session CSRF and logout', () => {
    it('rejects logout without CSRF on a live session', async () => {
      const harness = await createHarness();
      try {
        const { sessionCookie } = await completeLogin(harness.app);
        const logoutRes = await harness.app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: { cookie: sessionCookie, origin: APP_ORIGIN },
        });
        expect(logoutRes.statusCode).toBe(403);
      } finally {
        await harness.close();
      }
    });

    it('logout succeeds when resolveAuthorization is unavailable', async () => {
      const harness = await createHarness({
        resolveAuthorization: async () => {
          throw new Error('resolver_down');
        },
      });
      try {
        const { sessionCookie } = await completeLogin(harness.app);
        const sessionRes = await harness.app.inject({
          method: 'GET',
          url: '/auth/session',
          headers: { cookie: sessionCookie },
        });
        expect(sessionRes.statusCode).toBe(503);

        const csrfToken = await csrfForSessionCookie(harness, sessionCookie);
        const logoutRes = await harness.app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: {
            cookie: sessionCookie,
            origin: APP_ORIGIN,
            'x-csrf-token': csrfToken,
          },
        });
        expect(logoutRes.statusCode).toBe(200);
        expect(logoutRes.json().loggedOut).toBe(true);
      } finally {
        await harness.close();
      }
    });
  });

  describe('credential precedence', () => {
    it('does not fall back to session cookie when Authorization header is invalid', async () => {
      const harness = await createHarness({}, { bearer: { authenticate: async () => null } });
      try {
        const { sessionCookie } = await completeLogin(harness.app);
        const cookieName = 'plumbus_session';
        const cookieValue = decodeURIComponent(sessionCookie.split('=')[1] ?? '');
        const result = await harness.runtime.authenticator.authenticate({
          authorization: 'Bearer invalid',
          cookies: { [cookieName]: cookieValue },
          method: 'GET',
          path: '/api/test',
        });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.code).toBe('invalid_authorization');
        }
      } finally {
        await harness.close();
      }
    });

    it('rejects tampered session records', async () => {
      const harness = await createHarness();
      try {
        const { sessionCookie } = await completeLogin(harness.app);
        const protection = await createStorageProtection(
          { activeKey: { id: 'k1', value: TEST_KEY } },
          { applicationId: 'app1', environment: 'development' },
        );
        const cookieValue = decodeURIComponent(sessionCookie.split('=')[1] ?? '');
        const sessionIdHash = protection.hmac('session-id-hmac', cookieValue);
        const record = await harness.sessionStore.getByIdHash({
          applicationId: 'app1',
          sessionIdHash,
        });
        expect(record).not.toBeNull();
        if (record) {
          await harness.sessionStore.create({
            ...record,
            principalEnvelope: `${record.principalEnvelope}x`,
          });
        }
        const sessionRes = await harness.app.inject({
          method: 'GET',
          url: '/auth/session',
          headers: { cookie: sessionCookie },
        });
        expect(sessionRes.statusCode).toBe(503);
      } finally {
        await harness.close();
      }
    });
  });
});
