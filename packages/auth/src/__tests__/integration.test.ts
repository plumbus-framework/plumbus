import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createAuthRuntime } from '../runtime/create-runtime.js';
import { createMemoryLoginTransactionStore, createMemorySessionStore } from '../stores/memory.js';
import { startFakeOidcProvider } from '../testing/fake-oidc-provider.js';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('auth integration', () => {
  let fake: Awaited<ReturnType<typeof startFakeOidcProvider>>;
  let app: ReturnType<typeof Fastify>;
  const externalBaseUrl = 'http://127.0.0.1:3000';

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    app = Fastify();
    const runtime = createAuthRuntime({
      applicationId: 'app1',
      externalBaseUrl,
      applicationBaseUrl: 'http://127.0.0.1:5173',
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
          discoverable: true,
          display: { label: 'Test' },
        },
      },
      sessionStore: createMemorySessionStore(),
      transactionStore: createMemoryLoginTransactionStore(),
      storageProtection: { activeKey: { id: 'k1', value: TEST_KEY } },
      resolveIdentity: async () => ({ status: 'admitted', userId: 'user-1' }),
      resolveAuthorization: async () => ({
        status: 'authorized',
        roles: ['user'],
        scopes: ['read'],
      }),
      deployment: { assumeSameSite: true },
    });

    await runtime.initialize();
    runtime.registerRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fake.close();
  });

  it('login → callback → session → logout', async () => {
    const providers = await app.inject({ method: 'GET', url: '/auth/providers' });
    const providerList = providers.json();
    expect(providerList.providers[0]?.available).toBe(true);

    const loginRes = await app.inject({
      method: 'GET',
      url: '/auth/login/test?returnTo=/',
    });
    expect(loginRes.statusCode).toBe(302);
    const binding = loginRes.headers['set-cookie'] ?? '';
    const location = loginRes.headers.location ?? '';
    expect(location).toContain('/authorize');

    const providerRes = await fetch(location, { redirect: 'manual' });
    expect(providerRes.status).toBe(302);
    const callbackLocation = new URL(providerRes.headers.get('location') ?? '');

    const callbackRes = await app.inject({
      method: 'GET',
      url: `${callbackLocation.pathname}${callbackLocation.search}`,
      headers: { cookie: binding },
    });
    expect(callbackRes.statusCode).toBe(303);
    const sessionCookie = String(callbackRes.headers['set-cookie'] ?? '').split(';')[0] ?? '';

    const sessionRes = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: sessionCookie },
    });
    const session = sessionRes.json();
    expect(session.authenticated).toBe(true);
    expect(session.csrfToken).toBeTruthy();

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: sessionCookie,
        origin: 'http://127.0.0.1:5173',
        'x-csrf-token': session.csrfToken,
      },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json().loggedOut).toBe(true);
  });

  it('authenticator captured before initialize() resolves live sessions after init', async () => {
    const runtime = createAuthRuntime({
      applicationId: 'app1',
      externalBaseUrl,
      applicationBaseUrl: 'http://127.0.0.1:5173',
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
          discoverable: true,
          display: { label: 'Test' },
        },
      },
      sessionStore: createMemorySessionStore(),
      transactionStore: createMemoryLoginTransactionStore(),
      storageProtection: { activeKey: { id: 'k1', value: TEST_KEY } },
      resolveIdentity: async () => ({ status: 'admitted', userId: 'user-1' }),
      resolveAuthorization: async () => ({ status: 'authorized', roles: ['user'], scopes: [] }),
      deployment: { assumeSameSite: true },
    });

    // Capture before initialize — mirrors createServer capturing routeConfig at bootstrap.
    const captured = runtime.authenticator;

    const early = await captured.authenticate({ cookies: {}, method: 'GET', path: '/x' });
    expect(early.status).toBe('anonymous');

    const preInitApp = Fastify();
    await runtime.initialize();
    runtime.registerRoutes(preInitApp);
    await preInitApp.ready();

    const loginRes = await preInitApp.inject({ method: 'GET', url: '/auth/login/test' });
    const binding = loginRes.headers['set-cookie'] ?? '';
    const providerRes = await fetch(loginRes.headers.location ?? '', { redirect: 'manual' });
    const callbackLocation = new URL(providerRes.headers.get('location') ?? '');
    const callbackRes = await preInitApp.inject({
      method: 'GET',
      url: `${callbackLocation.pathname}${callbackLocation.search}`,
      headers: { cookie: binding },
    });
    const sessionCookie = String(callbackRes.headers['set-cookie'] ?? '').split(';')[0] ?? '';

    const cookieHeader = sessionCookie.split('=');
    const after = await captured.authenticate({
      cookies: { [cookieHeader[0] ?? '']: cookieHeader[1] ?? '' },
      method: 'GET',
      path: '/x',
    });
    expect(after.status).toBe('authenticated');

    await preInitApp.close();
    await runtime.close?.();
  });

  it('POST logout without CSRF returns 403 for live session', async () => {
    const loginRes = await app.inject({ method: 'GET', url: '/auth/login/test' });
    const binding = loginRes.headers['set-cookie'] ?? '';
    const providerRes = await fetch(loginRes.headers.location ?? '', { redirect: 'manual' });
    const callbackLocation = new URL(providerRes.headers.get('location') ?? '');
    const callbackRes = await app.inject({
      method: 'GET',
      url: `${callbackLocation.pathname}${callbackLocation.search}`,
      headers: { cookie: binding },
    });
    const cookie = String(callbackRes.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, origin: 'http://127.0.0.1:5173' },
    });
    expect(logoutRes.statusCode).toBe(403);
  });

  describe('errorReturnToParam', () => {
    async function runtimeApp(options: {
      errorReturnToParam?: string;
      admit?: boolean;
    }): Promise<ReturnType<typeof Fastify>> {
      const server = Fastify();
      const runtime = createAuthRuntime({
        applicationId: 'app1',
        externalBaseUrl,
        applicationBaseUrl: 'http://127.0.0.1:5173',
        defaultReturnPath: '/',
        errorPath: '/login/error',
        ...(options.errorReturnToParam ? { errorReturnToParam: options.errorReturnToParam } : {}),
        environment: 'development',
        session: { ttl: '1h' },
        providers: {
          test: {
            type: 'oidc',
            issuer: fake.issuer,
            clientId: 'test-client',
            clientSecret: 'test-secret',
            scopes: ['openid'],
          },
        },
        sessionStore: createMemorySessionStore(),
        transactionStore: createMemoryLoginTransactionStore(),
        storageProtection: { activeKey: { id: 'k1', value: TEST_KEY } },
        resolveIdentity: async () =>
          options.admit === false ? { status: 'denied' } : { status: 'admitted', userId: 'user-1' },
        resolveAuthorization: async () => ({ status: 'authorized', roles: [], scopes: [] }),
        deployment: { assumeSameSite: true },
      });
      await runtime.initialize();
      runtime.registerRoutes(server);
      await server.ready();
      return server;
    }

    async function startLogin(server: ReturnType<typeof Fastify>) {
      const loginRes = await server.inject({
        method: 'GET',
        url: `/auth/login/test?returnTo=${encodeURIComponent('/backups?college=alpha')}`,
      });
      expect(loginRes.statusCode).toBe(302);
      const state = new URL(loginRes.headers.location ?? '').searchParams.get('state') ?? '';
      return {
        binding: String(loginRes.headers['set-cookie'] ?? ''),
        state,
        location: loginRes.headers.location ?? '',
      };
    }

    it('carries the returnTo onto the error page when the person cancels at the provider', async () => {
      const server = await runtimeApp({ errorReturnToParam: 'next' });
      try {
        const { binding, state } = await startLogin(server);
        const res = await server.inject({
          method: 'GET',
          url: `/auth/callback/test?error=access_denied&state=${state}`,
          headers: { cookie: binding },
        });
        expect(res.statusCode).toBe(303);
        const target = new URL(res.headers.location ?? '', 'http://local');
        expect(target.pathname).toBe('/login/error');
        expect(target.searchParams.get('code')).toBe('login_cancelled');
        expect(target.searchParams.get('requestId')).toBeTruthy();
        expect(target.searchParams.get('next')).toBe('/backups?college=alpha');
      } finally {
        await server.close();
      }
    });

    it('carries the returnTo when the application refuses the identity after the code exchange', async () => {
      const server = await runtimeApp({ errorReturnToParam: 'next', admit: false });
      try {
        const { binding, location } = await startLogin(server);
        const providerRes = await fetch(location, { redirect: 'manual' });
        const callbackLocation = new URL(providerRes.headers.get('location') ?? '');
        const res = await server.inject({
          method: 'GET',
          url: `${callbackLocation.pathname}${callbackLocation.search}`,
          headers: { cookie: binding },
        });
        expect(res.statusCode).toBe(303);
        const target = new URL(res.headers.location ?? '', 'http://local');
        expect(target.searchParams.get('code')).toBe('login_failed');
        expect(target.searchParams.get('next')).toBe('/backups?college=alpha');
      } finally {
        await server.close();
      }
    });

    it('leaves the error URL as code and requestId only when the option is off', async () => {
      const server = await runtimeApp({});
      try {
        const { binding, state } = await startLogin(server);
        const res = await server.inject({
          method: 'GET',
          url: `/auth/callback/test?error=access_denied&state=${state}`,
          headers: { cookie: binding },
        });
        const target = new URL(res.headers.location ?? '', 'http://local');
        expect(target.searchParams.get('code')).toBe('login_cancelled');
        expect([...target.searchParams.keys()].sort()).toEqual(['code', 'requestId']);
      } finally {
        await server.close();
      }
    });

    it('never carries a destination when the state does not match a login of this browser', async () => {
      const server = await runtimeApp({ errorReturnToParam: 'next' });
      try {
        const { binding } = await startLogin(server);
        const res = await server.inject({
          method: 'GET',
          url: '/auth/callback/test?error=access_denied&state=forged',
          headers: { cookie: binding },
        });
        const target = new URL(res.headers.location ?? '', 'http://local');
        expect(target.searchParams.get('code')).toBe('login_cancelled');
        expect(target.searchParams.has('next')).toBe(false);
      } finally {
        await server.close();
      }
    });
  });
});
