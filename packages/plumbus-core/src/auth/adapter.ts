import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '../types/security.js';

/**
 * AuthAdapter normalizes an incoming request identity (e.g. a token)
 * into a standard AuthContext.
 */
export interface AuthAdapter {
  /**
   * Extract and verify credentials from the raw authorization header value.
   * Returns null if the token is missing or invalid.
   */
  authenticate(authorizationHeader: string | undefined): Promise<AuthContext | null>;
}

export interface JwtAdapterConfig {
  /** Secret key for HMAC or public key for RSA/EC verification */
  secret: string;
  /** Expected issuer (iss claim) */
  issuer?: string;
  /** Expected audience (aud claim) */
  audience?: string;
  /**
   * Map JWT claims to AuthContext fields.
   * Defaults: sub→userId, roles→roles, scope→scopes, tenant_id→tenantId
   */
  claimMapping?: Partial<JwtClaimMapping>;
}

export interface JwtClaimMapping {
  userId: string;
  roles: string;
  scopes: string;
  tenantId: string;
}

const defaultClaimMapping: JwtClaimMapping = {
  userId: 'sub',
  roles: 'roles',
  scopes: 'scope',
  tenantId: 'tenant_id',
};

/**
 * JWT-based auth adapter. Decodes, verifies HMAC-SHA256 signatures,
 * and validates JWT tokens, mapping claims to an AuthContext.
 */
export function createJwtAdapter(config: JwtAdapterConfig): AuthAdapter {
  const mapping = { ...defaultClaimMapping, ...config.claimMapping };

  return {
    async authenticate(authorizationHeader: string | undefined): Promise<AuthContext | null> {
      if (!authorizationHeader) return null;

      const token = extractBearerToken(authorizationHeader);
      if (!token) return null;

      const verified = verifyJwtHs256(token, config.secret);
      if (!verified) return null;
      const { payload } = verified;

      // Validate issuer if configured
      if (config.issuer && payload.iss !== config.issuer) {
        return null;
      }

      // Validate audience if configured
      if (config.audience) {
        const aud = payload.aud;
        const audiences = Array.isArray(aud) ? aud : [aud];
        if (!audiences.includes(config.audience)) {
          return null;
        }
      }

      // Check expiration
      const exp = payload.exp;
      if (typeof exp === 'number' && exp * 1000 < Date.now()) {
        return null;
      }

      // Map claims to AuthContext
      const rawRoles = payload[mapping.roles];
      const rawScopes = payload[mapping.scopes];

      return {
        userId: String(payload[mapping.userId] ?? ''),
        roles: Array.isArray(rawRoles)
          ? rawRoles.map(String)
          : typeof rawRoles === 'string'
            ? rawRoles.split(',').map((s: string) => s.trim())
            : [],
        scopes: Array.isArray(rawScopes)
          ? rawScopes.map(String)
          : typeof rawScopes === 'string'
            ? rawScopes.split(' ').filter(Boolean)
            : [],
        tenantId: payload[mapping.tenantId] ? String(payload[mapping.tenantId]) : undefined,
        provider: 'jwt',
        sessionId: payload.sid ? String(payload.sid) : undefined,
        authenticatedAt: payload.iat ? new Date((payload.iat as number) * 1000) : undefined,
      };
    },
  };
}

function extractBearerToken(header: string): string | null {
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = parts[1];
    if (!payload) return null;
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function verifyJwtHs256(
  token: string,
  secret: string,
): { payload: Record<string, unknown> } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  if (header.alg !== 'HS256') {
    return null;
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  const actual = Buffer.from(encodedSignature, 'base64url');

  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return { payload };
}

// ── JWT Signing ──

export interface SignJwtOptions {
  /** Secret key for HMAC-SHA256 signing */
  secret: string;
  /** Subject (userId) */
  sub: string;
  /** Roles */
  roles?: string[];
  /** Scopes */
  scopes?: string[];
  /** Tenant ID */
  tenantId?: string;
  /** Token expiration in seconds (default: 86400 = 24h) */
  expiresIn?: number;
  /** Issuer */
  issuer?: string;
  /** Additional claims */
  claims?: Record<string, unknown>;
}

/**
 * Sign a JWT token using HMAC-SHA256.
 * Returns the signed token string (header.payload.signature).
 */
export function signJwt(options: SignJwtOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (options.expiresIn ?? 86400);

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    sub: options.sub,
    iat: now,
    exp,
    ...options.claims,
  };

  if (options.roles?.length) payload.roles = options.roles;
  if (options.scopes?.length) payload.scope = options.scopes.join(' ');
  if (options.tenantId) payload.tenant_id = options.tenantId;
  if (options.issuer) payload.iss = options.issuer;

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', options.secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}
