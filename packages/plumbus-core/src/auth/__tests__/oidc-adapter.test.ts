import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createOidcAdapter } from '../oidc-adapter.js';

const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'my-app';

// Generate a test RSA key pair
const { publicKey: rsaPublicKey, privateKey: rsaPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const rsaJwk = rsaPublicKey.export({ format: 'jwk' }) as Record<string, unknown>;
rsaJwk.kid = 'test-rsa-key';
rsaJwk.use = 'sig';
rsaJwk.alg = 'RS256';

// Generate a test EC key pair
const { publicKey: ecPublicKey, privateKey: ecPrivateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});

const ecJwk = ecPublicKey.export({ format: 'jwk' }) as Record<string, unknown>;
ecJwk.kid = 'test-ec-key';
ecJwk.use = 'sig';
ecJwk.alg = 'ES256';

/** Sign a JWT with the RSA private key. */
function signRsaJwt(payload: Record<string, unknown>, kid = 'test-rsa-key'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), rsaPrivateKey);
  return `${header}.${body}.${signature.toString('base64url')}`;
}

/** Sign a JWT with the EC private key. */
function signEcJwt(payload: Record<string, unknown>, kid = 'test-ec-key'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('SHA256', Buffer.from(`${header}.${body}`), ecPrivateKey);
  return `${header}.${body}.${signature.toString('base64url')}`;
}

/** Build a mock fetch that serves discovery + JWKS. */
function mockFetch(jwksKeys: Record<string, unknown>[] = [rsaJwk, ecJwk]): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        }),
        { status: 200 },
      );
    }

    if (url.includes('jwks.json')) {
      return new Response(JSON.stringify({ keys: jwksKeys }), { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-42',
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    roles: ['admin'],
    scope: 'read write',
    tenant_id: 'tenant-1',
    ...overrides,
  };
}

describe('createOidcAdapter', () => {
  it('returns null for missing authorization header', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });
    expect(await adapter.authenticate(undefined)).toBeNull();
  });

  it('returns null for non-Bearer token', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });
    expect(await adapter.authenticate('Basic abc123')).toBeNull();
  });

  it('returns null for malformed JWT', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });
    expect(await adapter.authenticate('Bearer not-a-jwt')).toBeNull();
  });

  it('validates RS256-signed tokens', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });

    const token = signRsaJwt(validPayload());
    const result = await adapter.authenticate(`Bearer ${token}`);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-42');
    expect(result?.roles).toEqual(['admin']);
    expect(result?.scopes).toEqual(['read', 'write']);
    expect(result?.tenantId).toBe('tenant-1');
    expect(result?.provider).toBe('oidc');
  });

  it('validates ES256-signed tokens', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });

    const token = signEcJwt(validPayload());
    const result = await adapter.authenticate(`Bearer ${token}`);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-42');
    expect(result?.provider).toBe('oidc');
  });

  it('rejects expired tokens', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });

    const token = signRsaJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 60 }));
    expect(await adapter.authenticate(`Bearer ${token}`)).toBeNull();
  });

  it('rejects tokens with wrong issuer', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });

    const token = signRsaJwt(validPayload({ iss: 'https://evil.example.com' }));
    expect(await adapter.authenticate(`Bearer ${token}`)).toBeNull();
  });

  it('rejects tokens with wrong audience', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });

    const token = signRsaJwt(validPayload({ aud: 'wrong-audience' }));
    expect(await adapter.authenticate(`Bearer ${token}`)).toBeNull();
  });

  it('rejects tokens signed with unknown key', async () => {
    const adapter = createOidcAdapter({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchFn: mockFetch([]),
    });

    const token = signRsaJwt(validPayload());
    expect(await adapter.authenticate(`Bearer ${token}`)).toBeNull();
  });

  it('rejects unsupported algorithms', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });
    // Forge a token with HS256 alg (not supported by OIDC adapter)
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'test-rsa-key' }),
    ).toString('base64url');
    const body = Buffer.from(JSON.stringify(validPayload())).toString('base64url');
    const sig = 'fake-signature';
    expect(await adapter.authenticate(`Bearer ${header}.${body}.${sig}`)).toBeNull();
  });

  it('uses explicit jwksUri when provided', async () => {
    const fetchFn = mockFetch();
    const adapter = createOidcAdapter({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: `${ISSUER}/custom/jwks`,
      fetchFn,
    });

    const token = signRsaJwt(validPayload());
    await adapter.authenticate(`Bearer ${token}`);

    // Should NOT call discovery endpoint
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining('.well-known/openid-configuration'),
    );
  });

  it('caches JWKS keys', async () => {
    const fetchFn = mockFetch();
    const adapter = createOidcAdapter({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: `${ISSUER}/.well-known/jwks.json`,
      fetchFn,
    });

    const token1 = signRsaJwt(validPayload());
    const token2 = signRsaJwt(validPayload({ sub: 'user-99' }));

    await adapter.authenticate(`Bearer ${token1}`);
    await adapter.authenticate(`Bearer ${token2}`);

    // JWKS should be fetched only once (cached)
    const jwksCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('jwks.json'),
    );
    expect(jwksCalls).toHaveLength(1);
  });

  it('refreshes cache on key rotation (unknown kid)', async () => {
    // Start with empty JWKS (simulates key not yet published)
    let callCount = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('jwks.json')) {
        callCount++;
        // Second call returns the actual key
        const keys = callCount > 1 ? [rsaJwk] : [];
        return new Response(JSON.stringify({ keys }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const adapter = createOidcAdapter({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: `${ISSUER}/.well-known/jwks.json`,
      fetchFn,
    });

    const token = signRsaJwt(validPayload());
    const result = await adapter.authenticate(`Bearer ${token}`);

    expect(result?.userId).toBe('user-42');
    expect(callCount).toBe(2); // Fetched twice due to cache miss + refresh
  });

  it('supports custom claim mapping', async () => {
    const adapter = createOidcAdapter({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchFn: mockFetch(),
      claimMapping: {
        userId: 'email',
        roles: 'groups',
        tenantId: 'org_id',
      },
    });

    const token = signRsaJwt({
      ...validPayload(),
      email: 'user@example.com',
      groups: ['editors'],
      org_id: 'org-123',
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result?.userId).toBe('user@example.com');
    expect(result?.roles).toEqual(['editors']);
    expect(result?.tenantId).toBe('org-123');
  });

  it('returns null when JWKS fetch fails', async () => {
    const fetchFn = vi.fn(
      async () => new Response('Server Error', { status: 500 }),
    ) as typeof fetch;

    const adapter = createOidcAdapter({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: `${ISSUER}/.well-known/jwks.json`,
      fetchFn,
    });

    const token = signRsaJwt(validPayload());
    expect(await adapter.authenticate(`Bearer ${token}`)).toBeNull();
  });

  it('returns null when discovery fails', async () => {
    const fetchFn = vi.fn(async () => new Response('Not Found', { status: 404 })) as typeof fetch;

    const adapter = createOidcAdapter({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchFn,
    });

    const token = signRsaJwt(validPayload());
    expect(await adapter.authenticate(`Bearer ${token}`)).toBeNull();
  });

  it('handles multi-value audience', async () => {
    const adapter = createOidcAdapter({ issuer: ISSUER, audience: AUDIENCE, fetchFn: mockFetch() });

    const token = signRsaJwt(validPayload({ aud: ['other-app', AUDIENCE] }));
    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result?.userId).toBe('user-42');
  });
});
