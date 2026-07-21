import type { OidcProviderIntegration } from '@plumbus/auth';
import { buildHostedLoginParams } from './hosted-login.js';
import { buildCognitoLogoutUrl } from './logout.js';

export interface CognitoIntegrationOptions {
  hostedLogin?: {
    allowedIdentityProviders?: readonly string[];
    defaultIdentityProvider?: string;
    allowLangHint?: boolean;
  };
  logout?: {
    domain?: string;
  };
}

function validateOptions(options: CognitoIntegrationOptions | undefined): void {
  const logoutDomain = options?.logout?.domain;
  if (logoutDomain !== undefined) {
    let url: URL;
    try {
      url = new URL(logoutDomain);
    } catch {
      throw new TypeError('logout.domain must be a valid HTTPS URL');
    }
    if (url.protocol !== 'https:') {
      throw new TypeError('logout.domain must use https: protocol');
    }
    if (url.pathname !== '/') {
      throw new TypeError('logout.domain must have an empty pathname');
    }
    if (url.search || url.hash || url.username || url.password) {
      throw new TypeError('logout.domain must not include credentials, search, or hash');
    }
  }

  const allowlist = options?.hostedLogin?.allowedIdentityProviders;
  if (allowlist) {
    const seen = new Set<string>();
    for (const entry of allowlist) {
      if (!entry || Buffer.byteLength(entry, 'ascii') > 128) {
        throw new TypeError('allowlist entries must be non-empty ASCII strings up to 128 bytes');
      }
      if (seen.has(entry)) {
        throw new TypeError('allowlist entries must be unique');
      }
      seen.add(entry);
    }
    const defaultIdp = options.hostedLogin?.defaultIdentityProvider;
    if (defaultIdp && !seen.has(defaultIdp)) {
      throw new TypeError('defaultIdentityProvider must be present in allowedIdentityProviders');
    }
  }
}

export function cognito(options?: CognitoIntegrationOptions): OidcProviderIntegration {
  validateOptions(options);
  const frozenOptions = Object.freeze({
    hostedLogin: options?.hostedLogin ? Object.freeze({ ...options.hostedLogin }) : undefined,
    logout: options?.logout ? Object.freeze({ ...options.logout }) : undefined,
  });

  return Object.freeze({
    id: 'cognito',
    authorizationParams(input: Readonly<Record<string, string>>) {
      return buildHostedLoginParams(frozenOptions.hostedLogin, input);
    },
    selectClientAuthMethod(advertised: readonly string[]) {
      if (advertised.includes('client_secret_basic')) return 'client_secret_basic';
      if (advertised.includes('client_secret_post')) return 'client_secret_post';
      return undefined;
    },
    buildProviderLogoutUrl(input: {
      metadata: { endSessionEndpoint?: string };
      clientId: string;
      logoutUri: string;
    }) {
      return buildCognitoLogoutUrl(frozenOptions.logout?.domain, input);
    },
    validateRegistration(reg: {
      issuer: string;
      scopes: readonly string[];
      fetchUserInfo?: boolean;
      providerLogout?: { returnTo: string };
    }) {
      const warnings: string[] = [];
      if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[\w-]+$/.test(reg.issuer)) {
        warnings.push('issuer does not match the expected Cognito IdP URL pattern');
      }
      if (reg.providerLogout && !frozenOptions.logout?.domain) {
        warnings.push(
          'providerLogout is configured but logout.domain is missing; Cognito federated logout will be skipped because discovery does not advertise end_session_endpoint',
        );
      }
      return warnings;
    },
  });
}
