import { describe, expect, it } from 'vitest';
import type { NormalizedAuthRuntimeConfig } from '../../config/types.js';
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  verifyCsrfToken,
} from '../cookie.js';

function sessionCookieConfig(sameSite: 'Lax' | 'Strict'): NormalizedAuthRuntimeConfig {
  return {
    environment: 'development',
    session: {
      ttlMs: 3_600_000,
      cookieName: 'plumbus_session',
      maxSessionsPerUser: 5,
      sameSite,
    },
  } as NormalizedAuthRuntimeConfig;
}

describe('session cookie headers', () => {
  it('uses configured SameSite on session cookies', () => {
    expect(buildSessionCookieHeader(sessionCookieConfig('Lax'), 'abc', 60)).toContain(
      'SameSite=Lax',
    );
    expect(buildSessionCookieHeader(sessionCookieConfig('Strict'), 'abc', 60)).toContain(
      'SameSite=Strict',
    );
    expect(buildClearSessionCookieHeader(sessionCookieConfig('Strict'))).toContain(
      'SameSite=Strict',
    );
  });
});

describe('verifyCsrfToken', () => {
  it('compares presented token to stored hash', () => {
    const hmac = (value: string) => `hash:${value}`;
    expect(verifyCsrfToken(hmac, hmac('token-a'), 'token-a')).toBe(true);
    expect(verifyCsrfToken(hmac, hmac('token-a'), 'token-b')).toBe(false);
    expect(verifyCsrfToken(hmac, hmac('token-a'), undefined)).toBe(false);
  });
});
