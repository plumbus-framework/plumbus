import type { NormalizedAuthRuntimeConfig } from '../config/types.js';

const BINDING_COOKIE_NAME = 'plumbus_auth_binding';

export function bindingCookieName(environment: 'development' | 'production'): string {
  return environment === 'production' ? '__Host-plumbus_auth_binding' : BINDING_COOKIE_NAME;
}

export function buildBindingCookieHeader(
  config: NormalizedAuthRuntimeConfig,
  value: string,
  maxAgeSeconds: number,
): string {
  const name = bindingCookieName(config.environment);
  // Binding cookie must stay Lax so it is sent on the cross-site top-level GET from the IdP callback.
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.environment === 'production') {
    parts.push('Secure');
  }
  parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function readBindingCookie(
  cookies: Readonly<Record<string, string>>,
  environment: 'development' | 'production',
): string | undefined {
  return cookies[bindingCookieName(environment)];
}
