import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ErrorCode, PlumbusError } from '@plumbus/core/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { warnOnce } from '../internal/warn-once.js';
import { VOICE_CSRF_COOKIE_NAME, VOICE_CSRF_HEADER_NAME } from './csrf-names.js';

export { VOICE_CSRF_COOKIE_NAME, VOICE_CSRF_HEADER_NAME };

/**
 * Browser-request guard for cookie-authenticated voice HTTP routes. Same model as
 * `@plumbus/chat` (D3): exact Origin match against `externalBaseUrl`, plus a
 * principal-bound double-submit CSRF token. Opt-in: active only when both
 * `csrfSecret` and `externalBaseUrl` are configured.
 */
export interface VoiceBrowserGuardConfig {
  csrfSecret?: string;
  externalBaseUrl?: string;
}

export type VoiceCredentialSource = 'authorization_header' | 'cookie';

export interface VoiceRequestCredential {
  token: string | undefined;
  source: VoiceCredentialSource | undefined;
}

/** Authorization header first, then the first configured auth cookie (unchanged precedence). */
export function resolveVoiceRequestCredential(
  req: FastifyRequest,
  cookieNames: readonly string[],
): VoiceRequestCredential {
  const headerToken = req.headers.authorization;
  if (headerToken) return { token: headerToken, source: 'authorization_header' };

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return { token: undefined, source: undefined };

  for (const cookieName of cookieNames) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      if (key !== cookieName) continue;
      return {
        token: `Bearer ${decodeURIComponent(part.slice(eq + 1).trim())}`,
        source: 'cookie',
      };
    }
  }
  return { token: undefined, source: undefined };
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

/** Exact-Origin match. Both sides normalized; a missing side => false. */
export function originAllowed(
  requestOrigin: string | undefined,
  externalBaseUrl: string | undefined,
): boolean {
  const expected = normalizeOrigin(externalBaseUrl);
  const actual = normalizeOrigin(requestOrigin);
  if (!expected || !actual || expected === 'null') return false;
  return expected === actual;
}

function csrfBinding(auth: { userId?: string; tenantId?: string }): string {
  return `${auth.userId ?? ''}\u0000${auth.tenantId ?? ''}`;
}

function sign(secret: string, binding: string, nonce: string): string {
  return createHmac('sha256', secret)
    .update(binding)
    .update('\u0000')
    .update(nonce)
    .digest()
    .toString('base64url');
}

export function issueVoiceCsrfToken(secret: string, auth: { userId?: string; tenantId?: string }) {
  const nonce = randomBytes(18).toString('base64url');
  return `${nonce}.${sign(secret, csrfBinding(auth), nonce)}`;
}

export function verifyVoiceCsrfToken(
  secret: string,
  auth: { userId?: string; tenantId?: string },
  token: string | undefined,
): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const nonce = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(secret, csrfBinding(auth), nonce));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const cookies = (req as { cookies?: Record<string, string> }).cookies;
  if (cookies?.[name]) return cookies[name];
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Validate opt-in options at registration; throws on a malformed externalBaseUrl. */
export function assertValidExternalBaseUrl(externalBaseUrl: string | undefined): void {
  if (externalBaseUrl === undefined) return;
  let parsed: URL | undefined;
  try {
    parsed = new URL(externalBaseUrl);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new PlumbusError(
      ErrorCode.DependencyViolation,
      'Voice externalBaseUrl must be an absolute http:// or https:// URL',
    );
  }
}

export function browserGuardEnabled(config: VoiceBrowserGuardConfig): boolean {
  return Boolean(config.csrfSecret && config.externalBaseUrl);
}

/**
 * Call after a request authenticated successfully. Returns `{ ok: false }` when a
 * cookie-authenticated write fails the Origin/CSRF check. When the guard is off and
 * the request used cookie auth, logs a one-time warning. When the guard is on and
 * the request used cookie auth, (re)issues the CSRF cookie on the reply.
 */
export function guardVoiceBrowserRequest(
  req: FastifyRequest,
  reply: FastifyReply | undefined,
  auth: { userId?: string; tenantId?: string },
  source: VoiceCredentialSource | undefined,
  config: VoiceBrowserGuardConfig,
  opts: { mutation: boolean },
): { ok: true } | { ok: false; status: 403; body: unknown } {
  if (source !== 'cookie') return { ok: true };
  if (!browserGuardEnabled(config)) {
    warnOnce(
      'voice.cookie-auth-without-csrf',
      '[plumbus:voice] Cookie-authenticated voice request accepted without Origin/CSRF checks. Set csrfSecret and externalBaseUrl on the voice route options to protect browser requests.',
    );
    return { ok: true };
  }
  const csrfSecret = config.csrfSecret as string;
  const externalBaseUrl = config.externalBaseUrl as string;
  if (opts.mutation) {
    const rejected = {
      ok: false as const,
      status: 403 as const,
      body: { error: { code: 'voice.origin_invalid', message: 'Request origin rejected' } },
    };
    if (!originAllowed(req.headers.origin, externalBaseUrl)) return rejected;
    const rawHeader = req.headers[VOICE_CSRF_HEADER_NAME];
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const cookie = readCookie(req, VOICE_CSRF_COOKIE_NAME);
    // Bootstrap (same as chat): the first write before the browser holds the CSRF
    // cookie passes on the exact Origin match alone.
    if ((cookie || header) && !verifyVoiceCsrfToken(csrfSecret, auth, header)) return rejected;
  }
  if (reply) {
    const secure = externalBaseUrl.startsWith('https://');
    const value = `${VOICE_CSRF_COOKIE_NAME}=${issueVoiceCsrfToken(csrfSecret, auth)}; Path=/; SameSite=Strict`;
    reply.header('set-cookie', secure ? `${value}; Secure` : value);
  }
  return { ok: true };
}
