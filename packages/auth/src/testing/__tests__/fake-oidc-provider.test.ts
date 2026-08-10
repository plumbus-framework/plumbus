import { afterEach, describe, expect, it } from 'vitest';
import { startFakeOidcProvider } from '../fake-oidc-provider.js';

describe('fake OIDC provider', () => {
  let fake: Awaited<ReturnType<typeof startFakeOidcProvider>> | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('honors fake_sub query on authorize for id token subject', async () => {
    fake = await startFakeOidcProvider();
    const redirectUri = 'http://127.0.0.1/callback';
    const authorize = await fetch(
      `${fake.issuer}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=s1&nonce=n1&fake_sub=user-b`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get('location') ?? '');
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${fake.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code ?? '',
        client_id: 'test-client',
        grant_type: 'authorization_code',
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { id_token: string; access_token: string };
    const payload = JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { sub: string };
    expect(payload.sub).toBe('user-b');

    const userinfo = await fetch(`${fake.issuer}/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(200);
    expect(await userinfo.json()).toMatchObject({ sub: 'user-b' });
  });

  it('honors fake_sub in POST authorize body', async () => {
    fake = await startFakeOidcProvider({ subOverride: 'startup-user' });
    const redirectUri = 'http://127.0.0.1/callback';
    const authorize = await fetch(`${fake.issuer}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        redirect_uri: redirectUri,
        state: 's2',
        nonce: 'n2',
        fake_sub: 'from-body',
      }),
    });
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get('location') ?? '');
    const code = location.searchParams.get('code');

    const tokenRes = await fetch(`${fake.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code ?? '',
        client_id: 'test-client',
        grant_type: 'authorization_code',
      }),
    });
    const tokens = (await tokenRes.json()) as { id_token: string };
    const payload = JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { sub: string };
    expect(payload.sub).toBe('from-body');
  });

  it('falls back to subOverride when fake_sub is absent', async () => {
    fake = await startFakeOidcProvider({ subOverride: 'startup-user' });
    const redirectUri = 'http://127.0.0.1/callback';
    const authorize = await fetch(
      `${fake.issuer}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=s3`,
      { redirect: 'manual' },
    );
    const location = new URL(authorize.headers.get('location') ?? '');
    const code = location.searchParams.get('code');
    const tokenRes = await fetch(`${fake.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code ?? '',
        client_id: 'test-client',
        grant_type: 'authorization_code',
      }),
    });
    const tokens = (await tokenRes.json()) as { id_token: string };
    const payload = JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { sub: string };
    expect(payload.sub).toBe('startup-user');
  });
});
