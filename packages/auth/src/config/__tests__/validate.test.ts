import { describe, expect, it } from 'vitest';
import { validateAuthRuntimeConfig } from '../validate.js';
import {
  createMemoryLoginTransactionStore,
  createMemorySessionStore,
} from '../../stores/memory.js';
import type { AuthRuntimeConfig } from '../types.js';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function baseConfig(overrides: Partial<AuthRuntimeConfig> = {}): AuthRuntimeConfig {
  return {
    applicationId: 'app1',
    externalBaseUrl: 'http://127.0.0.1:3000',
    applicationBaseUrl: 'http://127.0.0.1:3000',
    defaultReturnPath: '/',
    errorPath: '/login/error',
    environment: 'development',
    session: { ttl: '8h' },
    providers: {
      test: {
        type: 'oidc',
        issuer: 'http://127.0.0.1:9999',
        clientId: 'client',
        clientSecret: 'secret',
        scopes: ['openid', 'email'],
        discoverable: true,
        display: { label: 'Test' },
      },
    },
    sessionStore: createMemorySessionStore(),
    transactionStore: createMemoryLoginTransactionStore(),
    storageProtection: { activeKey: { id: 'k1', value: TEST_KEY } },
    resolveIdentity: async () => ({ status: 'admitted', userId: 'user-1' }),
    resolveAuthorization: async () => ({ status: 'authorized', roles: [], scopes: [] }),
    ...overrides,
  };
}

describe('validateAuthRuntimeConfig', () => {
  it('accepts valid development config with default maxSessionsPerUser', () => {
    const normalized = validateAuthRuntimeConfig(baseConfig());
    expect(normalized.session.maxSessionsPerUser).toBe(5);
    expect(normalized.providers.test?.scopes).toContain('openid');
  });

  it('rejects diagnostics key via strict schema', () => {
    expect(() =>
      validateAuthRuntimeConfig({
        ...baseConfig(),
        diagnostics: { strictCors: true },
      } as AuthRuntimeConfig),
    ).toThrow();
  });

  it('rejects session ttl over 365 days', () => {
    expect(() => validateAuthRuntimeConfig(baseConfig({ session: { ttl: '366d' } }))).toThrow(
      /365 days/,
    );
  });

  it('rejects maxSessionsPerUser out of range', () => {
    expect(() =>
      validateAuthRuntimeConfig(baseConfig({ session: { ttl: '1h', maxSessionsPerUser: 0 } })),
    ).toThrow(/between 1 and 100/);
    expect(() =>
      validateAuthRuntimeConfig(baseConfig({ session: { ttl: '1h', maxSessionsPerUser: 101 } })),
    ).toThrow(/between 1 and 100/);
    expect(
      validateAuthRuntimeConfig(baseConfig({ session: { ttl: '1h', maxSessionsPerUser: 1 } })),
    ).toBeTruthy();
    expect(
      validateAuthRuntimeConfig(baseConfig({ session: { ttl: '1h', maxSessionsPerUser: 100 } })),
    ).toBeTruthy();
  });

  it('rejects offline_access scope', () => {
    expect(() =>
      validateAuthRuntimeConfig(
        baseConfig({
          providers: {
            test: {
              type: 'oidc',
              issuer: 'http://127.0.0.1:9999',
              clientId: 'client',
              clientSecret: 'secret',
              scopes: ['openid', 'offline_access'],
            },
          },
        }),
      ),
    ).toThrow(/offline_access/);
  });

  it('requires __Host- cookie prefix in production', () => {
    expect(() =>
      validateAuthRuntimeConfig(
        baseConfig({
          environment: 'production',
          externalBaseUrl: 'https://api.example.com',
          applicationBaseUrl: 'https://app.example.com',
          session: { ttl: '1h', cookieName: 'session' },
        }),
      ),
    ).toThrow(/__Host-/);
  });

  it('accepts clientSecret env and literal sources', () => {
    const withEnv = validateAuthRuntimeConfig(
      baseConfig({
        providers: {
          test: {
            type: 'oidc',
            issuer: 'http://127.0.0.1:9999',
            clientId: 'client',
            clientSecret: { env: 'OKTA_CLIENT_SECRET' },
            scopes: ['openid', 'email'],
            discoverable: true,
            display: { label: 'Test' },
          },
        },
      }),
    );
    expect(withEnv.providers.test?.clientSecret).toEqual({ env: 'OKTA_CLIENT_SECRET' });

    const withLiteral = validateAuthRuntimeConfig(
      baseConfig({
        providers: {
          test: {
            type: 'oidc',
            issuer: 'http://127.0.0.1:9999',
            clientId: 'client',
            clientSecret: { literal: 'dev-only-secret' },
            scopes: ['openid', 'email'],
            discoverable: true,
            display: { label: 'Test' },
          },
        },
      }),
    );
    expect(withLiteral.providers.test?.clientSecret).toEqual({ literal: 'dev-only-secret' });
  });

  it('defaults session.sameSite to Lax and accepts Strict', () => {
    expect(validateAuthRuntimeConfig(baseConfig()).session.sameSite).toBe('Lax');
    expect(
      validateAuthRuntimeConfig(baseConfig({ session: { ttl: '1h', sameSite: 'Strict' } })).session
        .sameSite,
    ).toBe('Strict');
  });
});
