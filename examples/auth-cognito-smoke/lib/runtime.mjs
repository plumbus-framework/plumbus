// Wires the @plumbus/auth OIDC relying-party runtime to cognitox using the
// @plumbus/auth-cognito cognito() integration — i.e. the exact object this smoke
// app exists to exercise. Everything provider-specific lives in cognito():
//   - authorizationParams  -> identity_provider / lang allowlisting (hosted UI)
//   - selectClientAuthMethod
//   - buildProviderLogoutUrl
//   - validateRegistration (issuer-shape warnings, surfaced at initialize())
import {
  cognito,
  createAuthRuntime,
  createMemoryLoginTransactionStore,
  createMemorySessionStore,
} from './deps.mjs';
import { ensureAppClient, ensurePool, ensureUser } from './cognitox-admin.mjs';

// 32-byte key (64 hex chars) for development storage protection. Fixed value is
// fine for a throwaway smoke app; never reuse this anywhere real.
const DEV_STORAGE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Build the cognito() integration object from resolved config. */
export function buildIntegration(cfg) {
  const options = {
    hostedLogin: { allowedIdentityProviders: cfg.allowedIdps },
  };
  if (cfg.providerLogoutDomain) {
    options.logout = { domain: cfg.providerLogoutDomain };
  }
  return cognito(options);
}

/**
 * Provision cognitox fixtures (idempotent) and return client credentials.
 * Skipped when cfg.autoProvision is false — then COGNITO_CLIENT_ID /
 * COGNITO_CLIENT_SECRET must be supplied via the environment.
 */
export async function resolveCredentials(cfg, log = () => {}) {
  if (!cfg.autoProvision) {
    const clientId = process.env.COGNITO_CLIENT_ID;
    const clientSecret = process.env.COGNITO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'AUTO_PROVISION=0 but COGNITO_CLIENT_ID / COGNITO_CLIENT_SECRET are not set.',
      );
    }
    log('auto-provision disabled; using COGNITO_CLIENT_ID / COGNITO_CLIENT_SECRET from env');
    return { poolId: cfg.poolId, clientId, clientSecret, user: { username: cfg.username } };
  }

  const poolId = await ensurePool({
    base: cfg.cognitoxUrl,
    poolId: cfg.poolId,
    poolName: cfg.poolName,
    log,
  });
  const client = await ensureAppClient({
    base: cfg.cognitoxUrl,
    poolId,
    clientName: cfg.clientName,
    callbackUrl: cfg.callbackUrl,
    logoutUrl: cfg.logoutUrl,
    log,
  });
  const user = await ensureUser({
    base: cfg.cognitoxUrl,
    poolId,
    username: cfg.username,
    password: cfg.password,
    email: cfg.username,
    log,
  });
  return { poolId, clientId: client.clientId, clientSecret: client.clientSecret, user };
}

/**
 * Create (but do not initialize) the auth runtime for the given config +
 * credentials. Uses in-memory stores and development mode so the http-only
 * cognitox endpoints are permitted.
 *
 * The resolveIdentity hook keys the user on the immutable Cognito `sub` and
 * reads `cognito:groups` from the ID token claims — the pattern the cognito
 * docs prescribe. resolveAuthorization returns a static role for the demo.
 */
export function buildAuthRuntime(cfg, credentials, hooks = {}) {
  const integration = buildIntegration(cfg);

  const runtime = createAuthRuntime({
    applicationId: 'auth-cognito-smoke',
    environment: 'development',
    externalBaseUrl: cfg.externalBaseUrl,
    applicationBaseUrl: cfg.applicationBaseUrl,
    defaultReturnPath: '/',
    errorPath: '/login-error',
    session: { ttl: '1h' },
    providers: {
      cognito: {
        type: 'oidc',
        // When the nonce proxy is enabled, the RP talks to it instead of cognitox
        // directly (cfg.oidcIssuer). Falls back to cognitox's own issuer.
        issuer: cfg.oidcIssuer ?? cfg.issuer,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scopes: ['openid', 'email', 'profile'],
        discoverable: true,
        display: { label: 'Sign in with Cognito' },
        integration,
        ...(cfg.providerLogoutDomain ? { providerLogout: { returnTo: '/' } } : {}),
      },
    },
    defaultProvider: 'cognito',
    sessionStore: createMemorySessionStore(),
    transactionStore: createMemoryLoginTransactionStore(),
    storageProtection: { activeKey: { id: 'dev', value: DEV_STORAGE_KEY } },
    resolveIdentity: async (identity) => {
      const groups = identity.idTokenClaims?.['cognito:groups'] ?? [];
      hooks.onIdentity?.({ subject: identity.subject, groups });
      // Deny-by-default in real apps; admit-all here since this is a smoke test.
      return { status: 'admitted', userId: identity.subject };
    },
    resolveAuthorization: async () => ({ status: 'authorized', roles: ['user'], scopes: [] }),
    deployment: { assumeSameSite: true },
  });

  return { runtime, integration };
}
