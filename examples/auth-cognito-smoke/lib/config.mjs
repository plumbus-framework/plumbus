// Resolves smoke-app configuration from the environment and the live cognitox
// discovery document. The single load-bearing subtlety: @plumbus/auth requires
// the configured issuer to EXACTLY equal the issuer advertised by discovery, so
// we always take the issuer from the discovery doc rather than guessing it.
import { fetchDiscovery } from './cognitox-admin.mjs';

const DEFAULTS = {
  // Where the cognito-idp admin API + discovery are reached. Matches the
  // COGNITOX_ISSUER_BASE_URL configured in docker-compose so this works from any
  // machine on the LAN. On the cognitox host you can also use http://localhost:9229.
  COGNITOX_URL: 'http://192.168.50.87:9229',
  // Pool is auto-resolved when COGNITO_USER_POOL_ID is unset: find/create by name.
  COGNITO_POOL_NAME: 'plumbus-auth-cognito-smoke',
  PORT: '3000',
  // Local nonce-injecting proxy port (adds the OIDC nonce cognitox omits).
  NONCE_PROXY_PORT: '9301',
  // '1' inserts a simulated one-time-code challenge into the hosted login
  // (multi-step login; code printed to the terminal). Off by default.
  OTP_MODE: '0',
  SMOKE_CLIENT_NAME: 'plumbus-auth-cognito-smoke',
  SMOKE_USERNAME: 'smoke@example.com',
  SMOKE_PASSWORD: 'SmokeTest123!',
  // Comma-separated IdP allowlist forwarded to Cognito's hosted UI via the
  // cognito() integration. COGNITO = the pool's native users.
  ALLOWED_IDPS: 'COGNITO,Google',
  // Optional HTTPS hosted-UI domain for federated logout URL construction.
  // cognitox is http-only, so this stays empty unless you point at real Cognito.
  PROVIDER_LOGOUT_DOMAIN: '',
  AUTO_PROVISION: '1',
};

function env(name) {
  const v = process.env[name];
  return v && v.length > 0 ? v : DEFAULTS[name];
}

/**
 * Build the resolved smoke config. Performs the discovery fetch and surfaces the
 * issuer/host-reachability caveat that decides whether the login flow can run.
 */
export async function loadConfig() {
  const cognitoxUrl = env('COGNITOX_URL').replace(/\/$/, '');
  // Optional: when unset the pool is found/created by name during provisioning.
  const poolId = process.env.COGNITO_USER_POOL_ID || undefined;
  const poolName = env('COGNITO_POOL_NAME');
  const port = Number(env('PORT'));
  const externalBaseUrl = (process.env.EXTERNAL_BASE_URL ?? `http://localhost:${port}`).replace(
    /\/$/,
    '',
  );
  // Single-origin smoke app: the server hosts both the landing page and /auth/*.
  const applicationBaseUrl = (process.env.APPLICATION_BASE_URL ?? externalBaseUrl).replace(
    /\/$/,
    '',
  );

  const discovery = await fetchDiscovery(cognitoxUrl);
  const issuer = discovery.issuer;

  const warnings = [];
  // The runtime performs discovery + token exchange against `issuer`, not against
  // COGNITOX_URL. If the advertised issuer host differs from where we reached
  // cognitox, the runtime's own calls may not resolve.
  const issuerHost = new URL(issuer).host;
  const reachedHost = new URL(cognitoxUrl).host;
  if (issuerHost !== reachedHost) {
    warnings.push(
      `cognitox advertises issuer "${issuer}" but you reached it at "${cognitoxUrl}". ` +
        'The auth runtime uses the advertised issuer for discovery + token exchange, ' +
        `so it must be reachable from this host. Either run this app on the cognitox host, ` +
        `or start cognitox with COGNITOX_ISSUER_BASE_URL=${cognitoxUrl} and retry.`,
    );
  }
  // The token endpoint is http; @plumbus/auth only permits that in development mode.
  const insecure = new URL(issuer).protocol === 'http:';

  const allowedIdps = env('ALLOWED_IDPS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    cognitoxUrl,
    poolId,
    poolName,
    port,
    nonceProxyPort: Number(env('NONCE_PROXY_PORT')),
    otpMode: env('OTP_MODE') === '1',
    externalBaseUrl,
    applicationBaseUrl,
    issuer,
    discovery,
    insecure,
    autoProvision: env('AUTO_PROVISION') !== '0',
    clientName: env('SMOKE_CLIENT_NAME'),
    username: env('SMOKE_USERNAME'),
    password: env('SMOKE_PASSWORD'),
    allowedIdps,
    providerLogoutDomain: env('PROVIDER_LOGOUT_DOMAIN'),
    callbackUrl: `${externalBaseUrl}/auth/callback/cognito`,
    logoutUrl: `${applicationBaseUrl}/`,
    warnings,
  };
}

/** Redact a secret for display. */
export function mask(secret) {
  if (!secret) return '(none)';
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
