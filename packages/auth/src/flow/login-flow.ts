import type { NormalizedAuthRuntimeConfig } from '../config/types.js';
import { validateProviderParams } from '../providers/registry.js';
import type { DiscoveredProvider } from '../providers/discovery.js';
import type { TransactionManager } from '../transactions/manager.js';
import { resolveBindingRaw } from '../transactions/manager.js';
import type { SessionManager } from '../sessions/manager.js';
import type { VerifiedExternalIdentity } from '../resolvers/types.js';
import { executeResolveIdentity } from '../resolvers/execute.js';
import * as client from 'openid-client';

function containsForbiddenReturnToChars(value: string): boolean {
  if (/\s/.test(value)) {
    return true;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function validateReturnTo(
  returnTo: string | undefined,
  defaultReturnPath: string,
  applicationBaseUrl: URL,
): string {
  const path = returnTo ?? defaultReturnPath;
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('invalid returnTo');
  }
  if (path.includes('\\') || path.includes('://')) {
    throw new Error('invalid returnTo');
  }
  if (containsForbiddenReturnToChars(path)) {
    throw new Error('invalid returnTo');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error('invalid returnTo');
  }
  if (decoded.startsWith('//') || decoded.includes('://') || decoded.includes('\\')) {
    throw new Error('invalid returnTo');
  }
  if (containsForbiddenReturnToChars(decoded)) {
    throw new Error('invalid returnTo');
  }

  const resolved = new URL(path, applicationBaseUrl);
  if (resolved.origin !== applicationBaseUrl.origin) {
    throw new Error('invalid returnTo');
  }
  const basePath = applicationBaseUrl.pathname.replace(/\/$/, '');
  if (basePath && !resolved.pathname.startsWith(basePath)) {
    throw new Error('invalid returnTo');
  }

  return `${resolved.pathname}${resolved.search}`;
}

export interface LoginFlowDeps {
  config: NormalizedAuthRuntimeConfig;
  transactions: TransactionManager;
  sessions: SessionManager;
  getDiscovered(providerId: string): DiscoveredProvider | undefined;
  resolveClientSecret(providerId: string): Promise<string>;
  clock?: () => Date;
}

export function createLoginFlow(deps: LoginFlowDeps) {
  const nowFn = deps.clock ?? (() => new Date());

  return {
    async startLogin(input: {
      providerId: string;
      returnTo?: string;
      query: Record<string, string>;
      cookies: Readonly<Record<string, string>>;
    }) {
      const provider = deps.config.providers[input.providerId];
      if (!provider) {
        throw new Error('unknown_provider');
      }
      const discovered = deps.getDiscovered(input.providerId);
      if (!discovered) {
        throw new Error('provider_unavailable');
      }

      const returnPath = validateReturnTo(
        input.returnTo,
        deps.config.defaultReturnPath,
        deps.config.applicationBaseUrl,
      );
      const paramResult = validateProviderParams(provider.integration, input.query);
      if (!paramResult.ok) {
        throw new Error('invalid_provider_params');
      }

      const binding = resolveBindingRaw(input.cookies, deps.config);
      const tx = await deps.transactions.createTransaction({
        providerId: input.providerId,
        returnTo: returnPath,
        providerParams: { ...paramResult.params },
        bindingRaw: binding.bindingRaw,
        now: nowFn(),
      });

      const redirectUri = new URL(
        `${deps.config.basePath}/callback/${input.providerId}`,
        deps.config.externalBaseUrl,
      ).toString();
      const authUrl = new URL(discovered.metadata.authorizationEndpoint);
      authUrl.searchParams.set('client_id', provider.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('response_mode', 'query');
      authUrl.searchParams.set('scope', provider.scopes.join(' '));
      authUrl.searchParams.set('state', tx.state);
      authUrl.searchParams.set('nonce', tx.nonce);
      authUrl.searchParams.set('code_challenge', tx.codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      for (const [key, value] of Object.entries(paramResult.params)) {
        authUrl.searchParams.set(key, value);
      }

      return {
        redirectUrl: authUrl.toString(),
        bindingCookie: binding.setCookie,
      };
    },

    async handleCallback(input: {
      providerId: string;
      query: URLSearchParams;
      cookies: Readonly<Record<string, string>>;
    }) {
      const duplicateKeys = new Set<string>();
      for (const key of input.query.keys()) {
        const values = input.query.getAll(key);
        if (values.length > 1 && ['code', 'state', 'error', 'iss'].includes(key)) {
          duplicateKeys.add(key);
        }
      }
      if (duplicateKeys.size > 0) {
        throw new Error('duplicate_query_params');
      }
      if (input.query.has('code') && input.query.has('error')) {
        throw new Error('code_and_error');
      }
      for (const forbidden of ['id_token', 'access_token', 'token']) {
        if (input.query.has(forbidden)) {
          throw new Error('front_channel_token');
        }
      }

      const providerError = input.query.get('error');
      if (providerError) {
        if (providerError === 'access_denied') {
          throw new Error('login_cancelled');
        }
        throw new Error('provider_unavailable');
      }

      const code = input.query.get('code');
      const state = input.query.get('state');
      if (!code || !state) {
        throw new Error('login_failed');
      }

      const provider = deps.config.providers[input.providerId];
      const discovered = deps.getDiscovered(input.providerId);
      if (!provider || !discovered) {
        throw new Error('provider_unavailable');
      }

      const iss = input.query.get('iss');
      if (iss && iss !== provider.issuer) {
        throw new Error('issuer_mismatch');
      }

      const bindingRaw =
        input.cookies[
          deps.config.environment === 'production'
            ? '__Host-plumbus_auth_binding'
            : 'plumbus_auth_binding'
        ];
      if (!bindingRaw) {
        throw new Error('login_failed');
      }

      const payload = await deps.transactions.consumeTransaction({
        state,
        bindingRaw,
        providerId: input.providerId,
        now: nowFn(),
      });
      if (!payload) {
        throw new Error('login_failed');
      }

      const redirectUri = new URL(
        `${deps.config.basePath}/callback/${input.providerId}`,
        deps.config.externalBaseUrl,
      );
      const currentUrl = new URL(
        `${redirectUri.pathname}${input.query.toString() ? `?${input.query.toString()}` : ''}`,
        deps.config.externalBaseUrl,
      );
      const grantOptions: Record<string, unknown> = {
        pkceCodeVerifier: payload.pkceVerifier,
        expectedNonce: payload.nonce,
        expectedState: payload.state,
      };
      if (deps.config.environment === 'development') {
        grantOptions.execute = [client.allowInsecureRequests];
      }
      const tokens = await client.authorizationCodeGrant(
        discovered.config,
        currentUrl,
        grantOptions,
      );

      const claims = tokens.claims();
      if (!claims?.sub) {
        throw new Error('login_failed');
      }

      let userInfoClaims: Record<string, unknown> | undefined;
      if (provider.fetchUserInfo && discovered.metadata.userinfoEndpoint) {
        const userinfo = await client.fetchUserInfo(
          discovered.config,
          tokens.access_token ?? '',
          claims.sub,
        );
        if (userinfo.sub !== claims.sub) {
          throw new Error('userinfo_sub_mismatch');
        }
        userInfoClaims = userinfo as unknown as Record<string, unknown>;
      }

      const identity: VerifiedExternalIdentity = {
        providerId: input.providerId,
        issuer: provider.issuer,
        subject: claims.sub,
        idTokenClaims: claims as unknown as Record<string, unknown>,
        userInfoClaims,
        providerAuthenticatedAt: claims.auth_time
          ? new Date(Number(claims.auth_time) * 1000)
          : undefined,
        acr: typeof claims.acr === 'string' ? claims.acr : undefined,
        amr: Array.isArray(claims.amr) ? (claims.amr as string[]) : undefined,
      };

      const admission = await executeResolveIdentity(
        deps.config.resolveIdentity,
        identity,
        deps.config.resolverTimeoutMs,
      );
      if (admission.status === 'temporary') {
        throw new Error('provider_unavailable');
      }
      if (admission.status === 'denied') {
        throw new Error('login_denied');
      }

      const session = await deps.sessions.createSession({
        userId: admission.userId,
        providerId: input.providerId,
        issuer: provider.issuer,
        subject: claims.sub,
        acr: identity.acr,
        amr: identity.amr,
        providerAuthenticatedAt: identity.providerAuthenticatedAt,
        now: nowFn(),
      });

      return {
        returnTo: payload.returnTo,
        setCookie: session.setCookie,
      };
    },
  };
}
