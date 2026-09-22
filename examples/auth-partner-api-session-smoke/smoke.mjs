#!/usr/bin/env node
// Smoke: @plumbus/auth cookie session authenticates @plumbus/api partner routes
// without a partner JWT (GitHub issue #46).
//
//   pnpm --filter @plumbus/core --filter @plumbus/auth --filter @plumbus/api build
//   node examples/auth-partner-api-session-smoke/smoke.mjs
//
// Exit 0 on success. Not part of the pnpm workspace / CI test graph.
import {
  Fastify,
  createAuthRuntime,
  createMemoryLoginTransactionStore,
  createMemorySessionStore,
  createTestAuth,
  defineCapability,
  mockAI,
  mockAudit,
  mockEvents,
  mockFlows,
  mockLogger,
  registerApiRoutes,
  startFakeOidcProvider,
  z,
} from './lib/deps.mjs';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EXTERNAL = 'http://127.0.0.1:3000';
const APP_ORIGIN = 'http://127.0.0.1:5173';

const results = [];

function record(name, status, detail = '') {
  results.push({ name, status, detail });
  const badge = status === 'PASS' ? '  PASS  ' : '  FAIL  ';
  console.log(`[${badge}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function loginAs(app, fakeSub) {
  const loginRes = await app.inject({
    method: 'GET',
    url: '/auth/login/test?returnTo=/',
  });
  assert(loginRes.statusCode === 302, `login expected 302, got ${loginRes.statusCode}`);
  const binding = loginRes.headers['set-cookie'] ?? '';
  const authorizeUrl = new URL(loginRes.headers.location ?? '');
  authorizeUrl.searchParams.set('fake_sub', fakeSub);

  const providerRes = await fetch(authorizeUrl, { redirect: 'manual' });
  assert(providerRes.status === 302, `authorize expected 302, got ${providerRes.status}`);
  const callbackLocation = new URL(providerRes.headers.get('location') ?? '');

  const callbackRes = await app.inject({
    method: 'GET',
    url: `${callbackLocation.pathname}${callbackLocation.search}`,
    headers: { cookie: binding },
  });
  assert(callbackRes.statusCode === 303, `callback expected 303, got ${callbackRes.statusCode}`);
  const cookie = String(callbackRes.headers['set-cookie'] ?? '').split(';')[0] ?? '';

  const sessionRes = await app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie },
  });
  const session = sessionRes.json();
  assert(session.authenticated === true, 'session should be authenticated');
  assert(Boolean(session.csrfToken), 'session should include csrfToken');
  return { cookie, csrfToken: session.csrfToken };
}

async function main() {
  console.log('\n@plumbus/auth × @plumbus/api — partner session smoke\n' + '='.repeat(52));

  const fake = await startFakeOidcProvider();
  const app = Fastify();

  const bearerAdapter = {
    authenticate: async (header) => {
      if (!header?.startsWith('Bearer machine-')) {
        return null;
      }
      return createTestAuth({
        userId: 'machine-user',
        roles: ['admin'],
        scopes: ['refunds:read'],
        tenantId: 'tenant-machine',
        provider: 'jwt',
      });
    },
  };

  const runtime = createAuthRuntime(
    {
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
          discoverable: true,
          display: { label: 'Test' },
        },
      },
      sessionStore: createMemorySessionStore(),
      transactionStore: createMemoryLoginTransactionStore(),
      storageProtection: { activeKey: { id: 'k1', value: TEST_KEY } },
      resolveIdentity: async (identity) => ({
        status: 'admitted',
        userId: identity.subject,
      }),
      resolveAuthorization: async (principal) => ({
        status: 'authorized',
        roles: ['admin'],
        scopes: ['refunds:read'],
        tenantId: `tenant-for-${principal.userId}`,
      }),
      deployment: { assumeSameSite: true },
    },
    { bearer: bearerAdapter },
  );

  // Capture the authenticator before initialize() — this mirrors how createServer
  // snapshots routeConfig.requestAuthenticator at bootstrap, before the auth plugin
  // initializes the runtime. Guards the #46 fix's documented wiring.
  const authenticator = runtime.authenticator;

  await runtime.initialize();
  runtime.registerRoutes(app);

  const getRefund = defineCapability({
    name: 'getRefund',
    kind: 'query',
    domain: 'billing',
    input: z.object({ refundId: z.string() }),
    output: z.object({
      refundId: z.string(),
      userId: z.string().optional(),
      tenantId: z.string().optional(),
    }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { roles: ['admin'], scopes: ['refunds:read'], tenantScoped: true },
    exposeAs: ['api'],
    api: {
      operationId: 'getRefund',
      method: 'GET',
      path: '/refunds/{refundId}',
    },
    handler: async (ctx, input) => ({
      refundId: input.refundId,
      userId: ctx.auth.userId,
      tenantId: ctx.auth.tenantId,
    }),
  });

  const approveRefund = defineCapability({
    name: 'approveRefund',
    kind: 'action',
    domain: 'billing',
    input: z.object({ refundId: z.string() }),
    output: z.object({
      refundId: z.string(),
      status: z.string(),
      userId: z.string().optional(),
    }),
    effects: { data: [], events: [], external: [], ai: false },
    access: { roles: ['admin'], scopes: ['refunds:read'], tenantScoped: true },
    exposeAs: ['api'],
    api: {
      operationId: 'approveRefund',
      method: 'POST',
      path: '/refunds/{refundId}/approve',
    },
    handler: async (ctx, input) => ({
      refundId: input.refundId,
      status: 'approved',
      userId: ctx.auth.userId,
    }),
  });

  registerApiRoutes(
    app,
    {
      db: {},
      authAdapter: bearerAdapter,
      requestAuthenticator: authenticator,
      createDependencies: (auth) => ({
        auth,
        data: {},
        events: mockEvents(),
        flows: mockFlows(),
        ai: mockAI(),
        audit: mockAudit(),
        logger: mockLogger(),
        config: {},
      }),
    },
    [getRefund, approveRefund],
    {
      manifest: {
        apiVersion: 'plumbus.dev/v1',
        name: 'smoke-api',
        basePath: '/api/v1',
        expose: [
          {
            capability: 'billing.getRefund',
            operationId: 'getRefund',
            method: 'GET',
            path: '/refunds/{refundId}',
          },
          {
            capability: 'billing.approveRefund',
            operationId: 'approveRefund',
            method: 'POST',
            path: '/refunds/{refundId}/approve',
          },
        ],
      },
    },
  );

  await app.ready();
  console.log('');

  try {
    try {
      const { cookie } = await loginAs(app, 'user-a');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/refunds/r1',
        headers: { cookie },
      });
      assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
      assert(
        JSON.stringify(res.json().data) ===
          JSON.stringify({
            refundId: 'r1',
            userId: 'user-a',
            tenantId: 'tenant-for-user-a',
          }),
        `unexpected body: ${JSON.stringify(res.json().data)}`,
      );
      record('cookie session → partner route (tenantId)', 'PASS', 'user-a');
    } catch (err) {
      record('cookie session → partner route (tenantId)', 'FAIL', err.message);
    }

    try {
      const { cookie } = await loginAs(app, 'user-b');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/refunds/r2',
        headers: { cookie },
      });
      assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
      assert(res.json().data.userId === 'user-b', `expected user-b, got ${res.json().data.userId}`);
      assert(
        res.json().data.tenantId === 'tenant-for-user-b',
        `expected tenant-for-user-b, got ${res.json().data.tenantId}`,
      );
      record('fake_sub selects different principal', 'PASS', 'user-b');
    } catch (err) {
      record('fake_sub selects different principal', 'FAIL', err.message);
    }

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/refunds/r3',
        headers: { authorization: 'Bearer machine-token' },
      });
      assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
      assert(res.json().data.userId === 'machine-user', 'expected machine-user');
      assert(res.json().data.tenantId === 'tenant-machine', 'expected tenant-machine');
      record('Bearer JWT still works alongside session', 'PASS');
    } catch (err) {
      record('Bearer JWT still works alongside session', 'FAIL', err.message);
    }

    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/refunds/r4' });
      assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
      assert(res.json().error?.code === 'unauthenticated', 'expected unauthenticated');
      record('anonymous partner call → unauthenticated', 'PASS');
    } catch (err) {
      record('anonymous partner call → unauthenticated', 'FAIL', err.message);
    }

    try {
      const { cookie, csrfToken } = await loginAs(app, 'user-c');
      const missingCsrf = await app.inject({
        method: 'POST',
        url: '/api/v1/refunds/r5/approve',
        headers: { cookie, origin: APP_ORIGIN },
        payload: {},
      });
      assert(missingCsrf.statusCode === 403, `expected 403, got ${missingCsrf.statusCode}`);
      assert(missingCsrf.json().error?.code === 'csrf_failed', 'expected csrf_failed');

      const withCsrf = await app.inject({
        method: 'POST',
        url: '/api/v1/refunds/r5/approve',
        headers: {
          cookie,
          origin: APP_ORIGIN,
          'x-csrf-token': csrfToken,
        },
        payload: {},
      });
      assert(withCsrf.statusCode === 200, `expected 200, got ${withCsrf.statusCode}`);
      assert(withCsrf.json().data?.userId === 'user-c', 'expected user-c on approve');
      assert(withCsrf.json().data?.status === 'approved', 'expected approved status');
      record('POST partner route requires CSRF; succeeds with token', 'PASS');
    } catch (err) {
      record('POST partner route requires CSRF; succeeds with token', 'FAIL', err.message);
    }
  } finally {
    await app.close();
    await fake.close();
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n' + '='.repeat(52));
  console.log(failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
