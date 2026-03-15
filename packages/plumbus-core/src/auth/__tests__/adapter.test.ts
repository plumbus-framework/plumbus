import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createJwtAdapter, signJwt } from '../adapter.js';

const TEST_SECRET = 'test-secret';

/** Helper: create a properly HMAC-signed JWT with an arbitrary payload. */
function signedJwt(secret: string, payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** Helper: create a fake-signed JWT (invalid signature). */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', 'not-the-real-secret').update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

describe('createJwtAdapter', () => {
  const adapter = createJwtAdapter({ secret: TEST_SECRET });

  it('returns null for missing authorization header', async () => {
    const result = await adapter.authenticate(undefined);
    expect(result).toBeNull();
  });

  it('returns null for non-Bearer token', async () => {
    const result = await adapter.authenticate('Basic abc123');
    expect(result).toBeNull();
  });

  it('returns null for malformed JWT', async () => {
    const result = await adapter.authenticate('Bearer not.a.valid.jwt');
    expect(result).toBeNull();
  });

  it('returns null for invalid signature', async () => {
    const token = fakeJwt({
      sub: 'user-42',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result).toBeNull();
  });

  it('returns null for token signed with wrong secret', async () => {
    const token = signedJwt('wrong-secret', {
      sub: 'user-42',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result).toBeNull();
  });

  it('extracts AuthContext from valid JWT claims', async () => {
    const token = signedJwt(TEST_SECRET, {
      sub: 'user-42',
      roles: ['admin', 'editor'],
      scope: 'read write',
      tenant_id: 't-1',
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-42');
    expect(result?.roles).toEqual(['admin', 'editor']);
    expect(result?.scopes).toEqual(['read', 'write']);
    expect(result?.tenantId).toBe('t-1');
    expect(result?.provider).toBe('jwt');
  });

  it('handles space-separated scopes', async () => {
    const token = signedJwt(TEST_SECRET, {
      sub: 'u1',
      scope: 'read write delete',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result?.scopes).toEqual(['read', 'write', 'delete']);
  });

  it('handles comma-separated roles', async () => {
    const token = signedJwt(TEST_SECRET, {
      sub: 'u1',
      roles: 'admin,editor',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result?.roles).toEqual(['admin', 'editor']);
  });

  it('returns null for expired tokens', async () => {
    const token = signedJwt(TEST_SECRET, {
      sub: 'u1',
      exp: Math.floor(Date.now() / 1000) - 60,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result).toBeNull();
  });

  it('validates issuer when configured', async () => {
    const strictAdapter = createJwtAdapter({
      secret: 's',
      issuer: 'my-app',
    });
    const token = signedJwt('s', {
      sub: 'u1',
      iss: 'wrong-issuer',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await strictAdapter.authenticate(`Bearer ${token}`);
    expect(result).toBeNull();
  });

  it('allows matching issuer', async () => {
    const strictAdapter = createJwtAdapter({
      secret: 's',
      issuer: 'my-app',
    });
    const token = signedJwt('s', {
      sub: 'u1',
      iss: 'my-app',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await strictAdapter.authenticate(`Bearer ${token}`);
    expect(result).not.toBeNull();
  });

  it('validates audience when configured', async () => {
    const audAdapter = createJwtAdapter({
      secret: 's',
      audience: 'api',
    });
    const token = signedJwt('s', {
      sub: 'u1',
      aud: 'other-service',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await audAdapter.authenticate(`Bearer ${token}`);
    expect(result).toBeNull();
  });

  it('supports custom claim mapping', async () => {
    const customAdapter = createJwtAdapter({
      secret: 's',
      claimMapping: {
        userId: 'user_id',
        roles: 'permissions',
        scopes: 'grants',
        tenantId: 'org_id',
      },
    });
    const token = signedJwt('s', {
      user_id: 'custom-user',
      permissions: ['superadmin'],
      grants: 'all',
      org_id: 'org-99',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await customAdapter.authenticate(`Bearer ${token}`);
    expect(result?.userId).toBe('custom-user');
    expect(result?.roles).toEqual(['superadmin']);
    expect(result?.tenantId).toBe('org-99');
  });

  it('sets authenticatedAt from iat claim', async () => {
    const iat = Math.floor(Date.now() / 1000) - 300;
    const token = signedJwt(TEST_SECRET, {
      sub: 'u1',
      iat,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result?.authenticatedAt).toEqual(new Date(iat * 1000));
  });
});

describe('signJwt', () => {
  it('produces a valid 3-part JWT', () => {
    const token = signJwt({ secret: 'test', sub: 'user-1' });
    expect(token.split('.')).toHaveLength(3);
  });

  it('includes sub claim', () => {
    const token = signJwt({ secret: 'test', sub: 'user-1' });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf-8'),
    );
    expect(payload.sub).toBe('user-1');
  });

  it('includes roles and scopes', () => {
    const token = signJwt({
      secret: 'test',
      sub: 'user-1',
      roles: ['admin', 'user'],
      scopes: ['read', 'write'],
    });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf-8'),
    );
    expect(payload.roles).toEqual(['admin', 'user']);
    expect(payload.scope).toBe('read write');
  });

  it('includes tenantId', () => {
    const token = signJwt({
      secret: 'test',
      sub: 'user-1',
      tenantId: 'tenant-42',
    });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf-8'),
    );
    expect(payload.tenant_id).toBe('tenant-42');
  });

  it('sets expiration', () => {
    const token = signJwt({ secret: 'test', sub: 'user-1', expiresIn: 3600 });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf-8'),
    );
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('roundtrips through createJwtAdapter', async () => {
    const secret = 'shared-secret';
    const token = signJwt({
      secret,
      sub: 'user-42',
      roles: ['owner'],
      tenantId: 'tenant-1',
      issuer: 'memoir-ai',
    });

    const adapter = createJwtAdapter({ secret, issuer: 'memoir-ai' });
    const auth = await adapter.authenticate(`Bearer ${token}`);
    expect(auth).not.toBeNull();
    expect(auth?.userId).toBe('user-42');
    expect(auth?.roles).toEqual(['owner']);
    expect(auth?.tenantId).toBe('tenant-1');
  });
});
