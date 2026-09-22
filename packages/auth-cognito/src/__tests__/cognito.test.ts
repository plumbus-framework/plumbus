import { describe, expect, it } from 'vitest';
import { cognito } from '../cognito.js';
import { buildHostedLoginParams } from '../hosted-login.js';
import { buildCognitoLogoutUrl } from '../logout.js';

describe('cognito integration', () => {
  it('returns frozen integration with expected keys only', () => {
    const integration = cognito();
    expect(Object.keys(integration).sort()).toEqual(
      [
        'authorizationParams',
        'buildProviderLogoutUrl',
        'id',
        'selectClientAuthMethod',
        'validateRegistration',
      ].sort(),
    );
    expect(integration.id).toBe('cognito');
  });

  it('selects client auth method from advertised values', () => {
    const integration = cognito();
    expect(
      integration.selectClientAuthMethod?.(['client_secret_post', 'client_secret_basic']),
    ).toBe('client_secret_basic');
    expect(integration.selectClientAuthMethod?.(['client_secret_post'])).toBe('client_secret_post');
  });

  it('validates logout domain and allowlist options', () => {
    expect(() => cognito({ logout: { domain: 'http://bad.example/' } })).toThrow(/https/);
    expect(() =>
      cognito({
        hostedLogin: {
          allowedIdentityProviders: ['Google'],
          defaultIdentityProvider: 'Missing',
        },
      }),
    ).toThrow(/defaultIdentityProvider/);
  });

  it('warns when providerLogout is set without logout.domain', () => {
    const integration = cognito();
    const warnings = integration.validateRegistration?.({
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf',
      scopes: ['openid'],
      providerLogout: { returnTo: '/' },
    });
    expect(warnings).toContain(
      'providerLogout is configured but logout.domain is missing; Cognito federated logout will be skipped because discovery does not advertise end_session_endpoint',
    );
  });
});

describe('hosted-login', () => {
  it('accepts allowlisted identity_provider and lang hint', () => {
    const result = buildHostedLoginParams(
      { allowedIdentityProviders: ['Google'], allowLangHint: true },
      { identity_provider: 'Google', lang: 'en-US' },
    );
    expect(result).toEqual({ ok: true, params: { identity_provider: 'Google', lang: 'en-US' } });
  });

  it('rejects unknown parameters', () => {
    expect(
      buildHostedLoginParams({ allowedIdentityProviders: ['Google'] }, { client_id: 'x' }),
    ).toEqual({ ok: false, reason: 'unsupported parameter: client_id' });
  });
});

describe('logout', () => {
  it('builds logout URL from metadata or configured domain', () => {
    const fromMetadata = buildCognitoLogoutUrl(undefined, {
      metadata: {
        endSessionEndpoint: 'https://example.auth.us-east-1.amazoncognito.com/oauth2/logout',
      },
      clientId: 'abc',
      logoutUri: 'https://app.example.com/signed-out',
    });
    expect(fromMetadata?.toString()).toContain('client_id=abc');
    expect(fromMetadata?.toString()).toContain('logout_uri=');

    const fromDomain = buildCognitoLogoutUrl('https://example.auth.us-east-1.amazoncognito.com/', {
      metadata: {},
      clientId: 'abc',
      logoutUri: 'https://app.example.com/signed-out',
    });
    expect(fromDomain?.pathname).toBe('/logout');
  });
});
