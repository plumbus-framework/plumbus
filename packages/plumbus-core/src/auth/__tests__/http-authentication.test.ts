import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../types/security.js';
import type { AuthAdapter } from '../adapter.js';
import { createCompositeRequestAuthenticator, wrapAuthAdapter } from '../http-authentication.js';

const authContext: AuthContext = {
  userId: 'user-1',
  roles: ['admin'],
  scopes: ['read'],
  provider: 'jwt',
};

function makeAdapter(
  impl: AuthAdapter['authenticate'],
): AuthAdapter & { authenticate: ReturnType<typeof vi.fn> } {
  return { authenticate: vi.fn(impl) };
}

describe('wrapAuthAdapter', () => {
  it('returns anonymous when authorization is undefined', async () => {
    const wrapped = wrapAuthAdapter(makeAdapter(async () => authContext));
    await expect(
      wrapped.authenticate({ authorization: undefined, cookies: {}, method: 'GET', path: '/' }),
    ).resolves.toEqual({
      status: 'anonymous',
    });
  });

  it('returns anonymous when authorization is empty', async () => {
    const wrapped = wrapAuthAdapter(makeAdapter(async () => authContext));
    await expect(
      wrapped.authenticate({ authorization: '', cookies: {}, method: 'GET', path: '/' }),
    ).resolves.toEqual({
      status: 'anonymous',
    });
  });

  it('returns anonymous when authorization is whitespace', async () => {
    const wrapped = wrapAuthAdapter(makeAdapter(async () => authContext));
    await expect(
      wrapped.authenticate({ authorization: '   ', cookies: {}, method: 'GET', path: '/' }),
    ).resolves.toEqual({
      status: 'anonymous',
    });
  });

  it('returns authenticated with the same AuthContext object', async () => {
    const wrapped = wrapAuthAdapter(makeAdapter(async () => authContext));
    const result = await wrapped.authenticate({
      authorization: 'Bearer token',
      cookies: {},
      method: 'GET',
      path: '/',
    });
    expect(result).toEqual({ status: 'authenticated', auth: authContext });
  });

  it('returns invalid when adapter returns null', async () => {
    const wrapped = wrapAuthAdapter(makeAdapter(async () => null));
    await expect(
      wrapped.authenticate({ authorization: 'Bearer bad', cookies: {}, method: 'GET', path: '/' }),
    ).resolves.toEqual({ status: 'invalid', code: 'invalid_authorization' });
  });

  it('returns unavailable when adapter throws', async () => {
    const wrapped = wrapAuthAdapter(
      makeAdapter(async () => {
        throw new Error('boom');
      }),
    );
    await expect(
      wrapped.authenticate({ authorization: 'Bearer bad', cookies: {}, method: 'GET', path: '/' }),
    ).resolves.toEqual({ status: 'unavailable', code: 'authentication_unavailable' });
  });
});

describe('createCompositeRequestAuthenticator', () => {
  it('uses bearer when header present and valid without calling session', async () => {
    const session = vi.fn();
    const composite = createCompositeRequestAuthenticator({
      bearer: makeAdapter(async () => authContext),
      session: { authenticate: session },
    });

    const result = await composite.authenticate({
      authorization: 'Bearer token',
      cookies: { session: 'abc' },
      method: 'GET',
      path: '/',
    });

    expect(result).toEqual({ status: 'authenticated', auth: authContext });
    expect(session).not.toHaveBeenCalled();
  });

  it('returns invalid when header present and bearer returns null without calling session', async () => {
    const session = vi.fn();
    const composite = createCompositeRequestAuthenticator({
      bearer: makeAdapter(async () => null),
      session: { authenticate: session },
    });

    await expect(
      composite.authenticate({
        authorization: 'Bearer bad',
        cookies: {},
        method: 'GET',
        path: '/',
      }),
    ).resolves.toEqual({ status: 'invalid', code: 'invalid_authorization' });
    expect(session).not.toHaveBeenCalled();
  });

  it('returns invalid when header present and no bearer configured', async () => {
    const session = vi.fn();
    const composite = createCompositeRequestAuthenticator({
      session: { authenticate: session },
    });

    await expect(
      composite.authenticate({
        authorization: 'Bearer token',
        cookies: {},
        method: 'GET',
        path: '/',
      }),
    ).resolves.toEqual({ status: 'invalid', code: 'invalid_authorization' });
    expect(session).not.toHaveBeenCalled();
  });

  it('passes through session result when no header is present', async () => {
    const sessionResults = [
      { status: 'anonymous' as const },
      { status: 'authenticated' as const, auth: authContext },
      { status: 'invalid' as const, code: 'invalid_authorization' as const },
      { status: 'unavailable' as const, code: 'authentication_unavailable' as const },
    ];

    for (const sessionResult of sessionResults) {
      const session = vi.fn().mockResolvedValue(sessionResult);
      const composite = createCompositeRequestAuthenticator({
        bearer: makeAdapter(async () => authContext),
        session: { authenticate: session },
      });

      await expect(
        composite.authenticate({ cookies: {}, method: 'GET', path: '/' }),
      ).resolves.toEqual(sessionResult);
    }
  });
});
