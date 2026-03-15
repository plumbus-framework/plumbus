import { createPublicKey, verify } from 'node:crypto';
import type { AuthContext } from '../types/security.js';
import type { AuthAdapter, JwtClaimMapping } from './adapter.js';

// ── OIDC Adapter ──
// Validates JWTs issued by OIDC-compliant identity providers using JWKS discovery.
// Supports RS256 and ES256 signing algorithms.

export interface OidcAdapterConfig {
  /** OIDC issuer URL (e.g., https://auth.example.com) */
  issuer: string;
  /** Expected audience (client ID) */
  audience: string;
  /** JWKS URI — auto-discovered from issuer if not provided */
  jwksUri?: string;
  /** Cache JWKS keys for this many seconds (default: 3600) */
  jwksCacheTtl?: number;
  /** Claim mapping override */
  claimMapping?: Partial<JwtClaimMapping>;
  /** Custom fetch function (for testing / environments without global fetch) */
  fetchFn?: typeof fetch;
}

export interface JsonWebKey {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

interface JwksCache {
  keys: JsonWebKey[];
  expiresAt: number;
}

const defaultClaimMapping: JwtClaimMapping = {
  userId: 'sub',
  roles: 'roles',
  scopes: 'scope',
  tenantId: 'tenant_id',
};

const SUPPORTED_ALGORITHMS = new Set(['RS256', 'ES256']);

/**
 * OIDC auth adapter. Validates JWT tokens from OIDC providers
 * by verifying signatures against JWKS keys fetched from the provider.
 */
export function createOidcAdapter(config: OidcAdapterConfig): AuthAdapter {
  const mapping = { ...defaultClaimMapping, ...config.claimMapping };
  const cacheTtl = (config.jwksCacheTtl ?? 3600) * 1000;
  const fetchFn = config.fetchFn ?? globalThis.fetch;

  let jwksCache: JwksCache | null = null;
  let discoveredJwksUri: string | null = config.jwksUri ?? null;

  async function discoverJwksUri(): Promise<string> {
    if (discoveredJwksUri) return discoveredJwksUri;

    const discoveryUrl = `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const response = await fetchFn(discoveryUrl);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed: ${response.status}`);
    }
    const doc = (await response.json()) as { jwks_uri?: string };
    if (!doc.jwks_uri) {
      throw new Error('OIDC discovery response missing jwks_uri');
    }
    discoveredJwksUri = doc.jwks_uri;
    return discoveredJwksUri;
  }

  async function fetchJwks(): Promise<JsonWebKey[]> {
    if (jwksCache && jwksCache.expiresAt > Date.now()) {
      return jwksCache.keys;
    }

    const jwksUri = await discoverJwksUri();
    const response = await fetchFn(jwksUri);
    if (!response.ok) {
      throw new Error(`JWKS fetch failed: ${response.status}`);
    }
    const jwks = (await response.json()) as { keys?: JsonWebKey[] };
    const keys = jwks.keys ?? [];

    jwksCache = { keys, expiresAt: Date.now() + cacheTtl };
    return keys;
  }

  function findKey(kid: string | undefined, keys: JsonWebKey[]): JsonWebKey | undefined {
    if (kid) {
      return keys.find((k) => k.kid === kid && k.use !== 'enc');
    }
    // If no kid in header, use the first signing key
    return keys.find((k) => k.use === 'sig' || !k.use);
  }

  return {
    async authenticate(authorizationHeader: string | undefined): Promise<AuthContext | null> {
      if (!authorizationHeader) return null;

      const token = extractBearerToken(authorizationHeader);
      if (!token) return null;

      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const headerStr = parts[0];
      const payloadStr = parts[1];
      const signatureStr = parts[2];
      if (!headerStr || !payloadStr || !signatureStr) return null;

      // Decode header to get kid and alg
      let header: { kid?: string; alg?: string };
      try {
        header = JSON.parse(Buffer.from(headerStr, 'base64url').toString('utf-8'));
      } catch {
        return null;
      }

      if (!header.alg || !SUPPORTED_ALGORITHMS.has(header.alg)) {
        return null;
      }

      // Fetch JWKS and find matching key
      let keys: JsonWebKey[];
      try {
        keys = await fetchJwks();
      } catch {
        return null;
      }

      const jwk = findKey(header.kid, keys);
      if (!jwk) {
        // Key not found — try refreshing cache in case of rotation
        jwksCache = null;
        try {
          keys = await fetchJwks();
        } catch {
          return null;
        }
        const refreshedJwk = findKey(header.kid, keys);
        if (!refreshedJwk) return null;
        return verifyAndMap(
          token,
          headerStr,
          payloadStr,
          signatureStr,
          refreshedJwk,
          header.alg,
          config,
          mapping,
        );
      }

      return verifyAndMap(
        token,
        headerStr,
        payloadStr,
        signatureStr,
        jwk,
        header.alg,
        config,
        mapping,
      );
    },
  };
}

function verifyAndMap(
  _token: string,
  headerStr: string,
  payloadStr: string,
  signatureStr: string,
  jwk: JsonWebKey,
  alg: string,
  config: OidcAdapterConfig,
  mapping: JwtClaimMapping,
): AuthContext | null {
  // Verify signature
  try {
    const publicKey = createPublicKey({ key: jwk as JsonWebKeyInput, format: 'jwk' });
    const algorithm = alg === 'RS256' ? 'RSA-SHA256' : 'SHA256';
    const signatureBuffer = Buffer.from(signatureStr, 'base64url');
    const data = `${headerStr}.${payloadStr}`;
    const valid = verify(algorithm, Buffer.from(data), publicKey, signatureBuffer);
    if (!valid) return null;
  } catch {
    return null;
  }

  // Decode payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }

  // Validate issuer
  if (payload.iss !== config.issuer) return null;

  // Validate audience
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(config.audience)) return null;

  // Check expiration
  const exp = payload.exp;
  if (typeof exp === 'number' && exp * 1000 < Date.now()) return null;

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
    provider: 'oidc',
    sessionId: payload.sid ? String(payload.sid) : undefined,
    authenticatedAt: payload.iat ? new Date((payload.iat as number) * 1000) : undefined,
  };
}

function extractBearerToken(header: string): string | null {
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

// Node.js crypto accepts JWK as this shape
type JsonWebKeyInput = {
  kty: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
};
