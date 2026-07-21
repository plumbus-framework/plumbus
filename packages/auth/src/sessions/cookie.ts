import { constantTimeEqual } from '../crypto/lookup.js';
import type { NormalizedAuthRuntimeConfig } from '../config/types.js';

export function buildSessionCookieHeader(
  config: NormalizedAuthRuntimeConfig,
  value: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${config.session.cookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${config.session.sameSite}`,
  ];
  if (config.environment === 'production') {
    parts.push('Secure');
  }
  parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function buildClearSessionCookieHeader(config: NormalizedAuthRuntimeConfig): string {
  const parts = [
    `${config.session.cookieName}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${config.session.sameSite}`,
    'Max-Age=0',
  ];
  if (config.environment === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function readSessionCookie(
  cookies: Readonly<Record<string, string>>,
  cookieName: string,
): string | undefined {
  return cookies[cookieName];
}

export function generateCsrfToken(hmac: (value: string) => string, sessionSecret: string): string {
  return hmac(sessionSecret);
}

export function verifyCsrfToken(
  hmac: (value: string) => string,
  storedHash: string,
  presented: string | undefined,
): boolean {
  if (!presented) return false;
  return constantTimeEqual(hmac(presented), storedHash);
}

export function parseOrigin(origin: string | undefined): URL | null {
  if (!origin || origin === 'null') return null;
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

export function originMatchesApplication(origin: URL, applicationBaseUrl: URL): boolean {
  const appPort =
    applicationBaseUrl.port || (applicationBaseUrl.protocol === 'https:' ? '443' : '80');
  const originPort = origin.port || (origin.protocol === 'https:' ? '443' : '80');
  return (
    origin.protocol === applicationBaseUrl.protocol &&
    origin.hostname === applicationBaseUrl.hostname &&
    originPort === appPort
  );
}
