import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '@plumbus/core';

// Declared in ../protocol.js so browser clients can read them without pulling
// node:crypto (and the rest of this module's graph) into their bundle.
export { CHAT_CSRF_COOKIE_NAME, CHAT_CSRF_HEADER_NAME } from '../protocol.js';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Binds a CSRF token to the authenticated principal so a token minted for one
 * user cannot be replayed as another. userId + tenantId, NUL-separated.
 */
export function csrfBindingFromAuth(auth: AuthContext): string {
  const userId = (auth as { userId?: string }).userId ?? '';
  const tenantId = (auth as { tenantId?: string }).tenantId ?? '';
  return `${userId}\u0000${tenantId}`;
}

function sign(secret: string, binding: string, nonce: string): string {
  return b64url(
    createHmac('sha256', secret).update(binding).update('\u0000').update(nonce).digest(),
  );
}

/** Issue a fresh session-bound CSRF token of the form `${nonce}.${sig}`. */
export function issueCsrfToken(secret: string, binding: string): string {
  const nonce = b64url(randomBytes(18));
  const sig = sign(secret, binding, nonce);
  return `${nonce}.${sig}`;
}

/** Verify a submitted token against the binding. Constant-time; never throws. */
export function verifyCsrfToken(
  secret: string,
  binding: string,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const nonce = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(secret, binding, nonce);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Normalize to scheme://host[:port]; undefined on parse failure. */
export function normalizeOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Exact-Origin match (D3). Both sides normalized; a missing side => false. */
export function originAllowed(
  requestOrigin: string | undefined,
  externalBaseUrl: string | undefined,
): boolean {
  const expected = normalizeOrigin(externalBaseUrl);
  const actual = normalizeOrigin(requestOrigin);
  if (!expected || !actual) return false;
  return expected === actual;
}
