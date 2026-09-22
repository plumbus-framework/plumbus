import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AuthRuntimeConfig, ResolveLoginContext } from '../../config/types.js';
import { createAuthRuntime } from '../../runtime/create-runtime.js';
import type { IdentityResolutionContext, VerifiedExternalIdentity } from '../../resolvers/types.js';
import {
  createMemoryLoginTransactionStore,
  createMemorySessionStore,
} from '../../stores/memory.js';
import { startFakeOidcProvider } from '../../testing/fake-oidc-provider.js';
import { normalizeApplicationContext, splitLoginQuery } from '../login-flow.js';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EXTERNAL = 'http://127.0.0.1:3000';
const APP_ORIGIN = 'http://127.0.0.1:5173';

interface AuditRecord {
  action: string;
  metadata?: Record<string, unknown>;
}

interface Harness {
  app: ReturnType<typeof Fastify>;
  fake: Awaited<ReturnType<typeof startFakeOidcProvider>>;
  resolverCalls: Array<{
    identity: VerifiedExternalIdentity;
    context?: IdentityResolutionContext;
  }>;
  audits: AuditRecord[];
  setNow(next: Date): void;
  close(): Promise<void>;
}

/** Admits identities that arrived through an invitation context, denies everyone else. */
async function createHarness(
  overrides: {
    resolve?: ResolveLoginContext;
    params?: string[];
    maxBytes?: number;
    transactionTtl?: string;
  } = {},
): Promise<Harness> {
  const fake = await startFakeOidcProvider();
  const app = Fastify();
  const resolverCalls: Harness['resolverCalls'] = [];
  const audits: AuditRecord[] = [];
  let now = new Date('2026-01-01T00:00:00.000Z');

  const loginContext: NonNullable<AuthRuntimeConfig['loginContext']> = {
    resolve:
      overrides.resolve ??
      (({ params }) =>
        params.invite ? { type: 'invitation', data: { invitationId: params.invite } } : undefined),
    params: overrides.params ?? ['invite'],
    ...(overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes }),
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
      transactions: overrides.transactionTtl ? { ttl: overrides.transactionTtl } : undefined,
      loginContext,
      providers: {
        test: {
          type: 'oidc',
          issuer: fake.issuer,
          clientId: 'test-client',
          clientSecret: 'test-secret',
          scopes: ['openid'],
        },
        other: {
          type: 'oidc',
          issuer: fake.issuer,
          clientId: 'other-client',
          clientSecret: 'other-secret',
          scopes: ['openid'],
        },
      },
      defaultProvider: 'test',
      sessionStore: createMemorySessionStore(),
      transactionStore: createMemoryLoginTransactionStore(),
      storageProtection: { activeKey: { id: 'k1', value: TEST_KEY } },
      resolveIdentity: async (identity, context) => {
        resolverCalls.push({ identity, context });
        const applicationContext = context?.applicationContext;
        if (applicationContext?.type !== 'invitation') {
          return { status: 'denied' };
        }
        return { status: 'admitted', userId: 'user-1' };
      },
      resolveAuthorization: async () => ({ status: 'authorized', roles: [], scopes: [] }),
      auditWriter: {
        write: async (event: AuditRecord) => {
          audits.push(event);
        },
      } as AuthRuntimeConfig['auditWriter'],
      deployment: { assumeSameSite: true },
    },
    { clock: () => now },
  );

  await runtime.initialize();
  runtime.registerRoutes(app);
  await app.ready();

  return {
    app,
    fake,
    resolverCalls,
    audits,
    setNow: (next) => {
      now = next;
    },
    close: async () => {
      await app.close();
      await fake.close();
    },
  };
}

async function startLogin(harness: Harness, url: string) {
  const loginRes = await harness.app.inject({ method: 'GET', url });
  const binding = loginRes.headers['set-cookie'] ?? '';
  return { loginRes, binding, location: loginRes.headers.location ?? '' };
}

async function followToCallbackPath(location: string): Promise<string> {
  const providerRes = await fetch(location, { redirect: 'manual' });
  const callbackLocation = new URL(providerRes.headers.get('location') ?? '');
  return `${callbackLocation.pathname}${callbackLocation.search}`;
}

async function completeLogin(harness: Harness, url: string, callbackProviderId = 'test') {
  const { binding, location } = await startLogin(harness, url);
  const callbackPath = (await followToCallbackPath(location)).replace(
    '/auth/callback/test',
    `/auth/callback/${callbackProviderId}`,
  );
  const callbackRes = await harness.app.inject({
    method: 'GET',
    url: callbackPath,
    headers: { cookie: binding },
  });
  return { binding, callbackPath, callbackRes, location };
}

describe('splitLoginQuery', () => {
  it('separates returnTo, provider params, and declared context params', () => {
    const split = splitLoginQuery(
      { returnTo: '/dashboard', invite: 'abc', prompt: 'login', dropped: undefined },
      ['invite'],
    );
    expect(split.returnTo).toBe('/dashboard');
    expect(split.contextParams).toEqual({ invite: 'abc' });
    expect(split.providerParams).toEqual({ prompt: 'login' });
  });

  it('treats undeclared params as provider params', () => {
    const split = splitLoginQuery({ invite: 'abc' }, []);
    expect(split.contextParams).toEqual({});
    expect(split.providerParams).toEqual({ invite: 'abc' });
  });
});

describe('normalizeApplicationContext', () => {
  it('returns a frozen JSON-only copy', () => {
    const normalized = normalizeApplicationContext(
      { type: 'invitation', data: { invitationId: 'inv-1' } },
      1024,
    );
    expect(normalized).toEqual({ type: 'invitation', data: { invitationId: 'inv-1' } });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('drops values JSON cannot represent', () => {
    const normalized = normalizeApplicationContext(
      { type: 'invitation', data: { keep: 'yes', drop: undefined, fn: () => 'no' } },
      1024,
    );
    expect(normalized.data).toEqual({ keep: 'yes' });
  });

  it('rejects a missing or oversized type', () => {
    expect(() => normalizeApplicationContext({ type: '' } as never, 1024)).toThrow(
      /invalid_login_context/,
    );
    expect(() => normalizeApplicationContext({ type: 'x'.repeat(129) }, 1024)).toThrow(
      /invalid_login_context/,
    );
  });

  it('rejects non-object data and non-serializable values', () => {
    expect(() => normalizeApplicationContext({ type: 't', data: [] as never }, 1024)).toThrow(
      /invalid_login_context/,
    );
    expect(() =>
      normalizeApplicationContext({ type: 't', data: { big: 1n } as never }, 1024),
    ).toThrow(/invalid_login_context/);
  });

  it('rejects context over the byte budget', () => {
    expect(() =>
      normalizeApplicationContext({ type: 't', data: { blob: 'x'.repeat(2048) } }, 1024),
    ).toThrow(/invalid_login_context/);
  });
});

describe('login application context', () => {
  it('hands the sealed context to resolveIdentity and admits the invited identity', async () => {
    const harness = await createHarness();
    try {
      const { callbackRes } = await completeLogin(harness, '/auth/login/test?invite=inv-1');
      expect(callbackRes.statusCode).toBe(303);
      expect(callbackRes.headers['set-cookie']).toBeTruthy();
      expect(harness.resolverCalls).toHaveLength(1);
      expect(harness.resolverCalls[0]?.context?.applicationContext).toEqual({
        type: 'invitation',
        data: { invitationId: 'inv-1' },
      });
    } finally {
      await harness.close();
    }
  });

  it('supports context on the default-provider login route', async () => {
    const harness = await createHarness();
    try {
      const { callbackRes } = await completeLogin(harness, '/auth/login?invite=inv-2');
      expect(callbackRes.statusCode).toBe(303);
      expect(harness.resolverCalls[0]?.context?.applicationContext?.data).toEqual({
        invitationId: 'inv-2',
      });
    } finally {
      await harness.close();
    }
  });

  it('omits the context for ordinary login and lets the resolver deny', async () => {
    const harness = await createHarness();
    try {
      const { callbackRes } = await completeLogin(harness, '/auth/login/test?returnTo=/');
      expect(callbackRes.statusCode).toBe(303);
      expect(callbackRes.headers.location).toContain('code=login_failed');
      expect(harness.resolverCalls).toHaveLength(1);
      expect(harness.resolverCalls[0]?.context?.applicationContext).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('never sends context params to the identity provider', async () => {
    const harness = await createHarness();
    try {
      const { location } = await completeLogin(harness, '/auth/login/test?invite=inv-3');
      expect(location).not.toContain('invite');
      expect(Object.keys(harness.fake.lastAuthorizeParams ?? {})).not.toContain('invite');
    } finally {
      await harness.close();
    }
  });

  it('still rejects query params that are not declared context params', async () => {
    const harness = await createHarness();
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/auth/login/test?foo=bar' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
    } finally {
      await harness.close();
    }
  });

  it('fails closed with 503 when the context hook throws', async () => {
    const harness = await createHarness({
      resolve: () => {
        throw new Error('invitation lookup down');
      },
    });
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/auth/login/test?invite=inv-4' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'login_unavailable' });
      expect(harness.resolverCalls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('rejects oversized context with 400 before redirecting to the provider', async () => {
    const harness = await createHarness({
      resolve: () => ({ type: 'invitation', data: { blob: 'x'.repeat(4096) } }),
    });
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/auth/login/test?invite=inv-5' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
    } finally {
      await harness.close();
    }
  });

  it('rejects context that is not JSON-serializable', async () => {
    const harness = await createHarness({
      resolve: () => ({ type: 'invitation', data: { big: 1n } as never }),
    });
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/auth/login/test?invite=inv-6' });
      expect(res.statusCode).toBe(400);
    } finally {
      await harness.close();
    }
  });

  it('does not expose the context on a replayed transaction', async () => {
    const harness = await createHarness();
    try {
      const { binding, callbackPath } = await completeLogin(
        harness,
        '/auth/login/test?invite=inv-7',
      );
      const replay = await harness.app.inject({
        method: 'GET',
        url: callbackPath,
        headers: { cookie: binding },
      });
      expect(replay.statusCode).toBe(303);
      expect(replay.headers.location).toContain('code=login_failed');
      expect(harness.resolverCalls).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('does not expose the context on an expired transaction', async () => {
    const harness = await createHarness({ transactionTtl: '1m' });
    try {
      const { binding, location } = await startLogin(harness, '/auth/login/test?invite=inv-8');
      const callbackPath = await followToCallbackPath(location);
      harness.setNow(new Date('2026-01-01T00:05:00.000Z'));
      const callbackRes = await harness.app.inject({
        method: 'GET',
        url: callbackPath,
        headers: { cookie: binding },
      });
      expect(callbackRes.statusCode).toBe(303);
      expect(callbackRes.headers.location).toContain('code=login_failed');
      expect(harness.resolverCalls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('does not expose the context when the browser binding is missing', async () => {
    const harness = await createHarness();
    try {
      const { location } = await startLogin(harness, '/auth/login/test?invite=inv-9');
      const callbackPath = await followToCallbackPath(location);
      const callbackRes = await harness.app.inject({ method: 'GET', url: callbackPath });
      expect(callbackRes.statusCode).toBe(303);
      expect(callbackRes.headers.location).toContain('code=login_failed');
      expect(harness.resolverCalls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('does not expose the context when the callback provider does not match', async () => {
    const harness = await createHarness();
    try {
      const { callbackRes } = await completeLogin(
        harness,
        '/auth/login/test?invite=inv-10',
        'other',
      );
      expect(callbackRes.statusCode).toBe(303);
      expect(callbackRes.headers.location).toContain('code=login_failed');
      expect(harness.resolverCalls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('keeps the context out of the session response and audit metadata', async () => {
    const harness = await createHarness();
    try {
      const { callbackRes } = await completeLogin(harness, '/auth/login/test?invite=inv-11');
      const sessionCookie = String(callbackRes.headers['set-cookie'] ?? '').split(';')[0] ?? '';
      const sessionRes = await harness.app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: sessionCookie },
      });
      expect(sessionRes.json().authenticated).toBe(true);
      expect(JSON.stringify(sessionRes.json())).not.toContain('inv-11');
      expect(JSON.stringify(sessionRes.json())).not.toContain('invitation');

      expect(harness.audits.map((entry) => entry.action)).toContain('auth.login.succeeded');
      for (const entry of harness.audits) {
        expect(Object.keys(entry.metadata ?? {}).sort()).not.toContain('applicationContext');
        expect(JSON.stringify(entry)).not.toContain('inv-11');
      }
    } finally {
      await harness.close();
    }
  });
});
