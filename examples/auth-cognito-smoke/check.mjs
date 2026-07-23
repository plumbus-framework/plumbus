// Automated smoke check for @plumbus/auth-cognito against a running cognitox.
//
// Runs a battery of assertions with NO browser, printing a PASS/FAIL table.
// It exercises everything the cognito() integration contributes through a real
// @plumbus/auth runtime pointed at cognitox, then attempts a full headless
// login by driving cognitox's hosted UI programmatically.
//
//   node check.mjs
//
// The OIDC flow is routed through a local nonce proxy (lib/nonce-proxy.mjs) that
// injects the `nonce` claim cognitox omits, so the full token->session step
// completes. Exit code is non-zero if any required check fails.
import { createHash, randomBytes } from 'node:crypto';
import { cognito, Fastify } from './lib/deps.mjs';
import { loadConfig, mask } from './lib/config.mjs';
import { startNonceProxy } from './lib/nonce-proxy.mjs';
import { buildAuthRuntime, resolveCredentials } from './lib/runtime.mjs';

const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  const badge = { PASS: '  PASS  ', FAIL: '  FAIL  ', BLOCKED: 'BLOCKED ', WARN: '  WARN  ' }[status];
  console.log(`[${badge}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function check(name, fn) {
  try {
    const detail = fn();
    record(name, 'PASS', detail || '');
    return true;
  } catch (err) {
    record(name, 'FAIL', err.message);
    return false;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function main() {
  const cfg = await loadConfig();

  console.log('\n@plumbus/auth-cognito — smoke check\n' + '='.repeat(38));
  console.log(`cognitox     ${cfg.cognitoxUrl}`);
  console.log(`issuer       ${cfg.issuer}`);
  console.log(`user pool    ${cfg.poolId ?? '(auto — find/create by name)'}`);
  console.log(`external URL  ${cfg.externalBaseUrl}`);
  console.log(`allowed IdPs ${cfg.allowedIdps.join(', ')}`);
  for (const w of cfg.warnings) console.log(`\n⚠  ${w}`);
  console.log('');

  // --- Provision fixtures -------------------------------------------------
  let credentials;
  try {
    credentials = await resolveCredentials(cfg, (m) => console.log(`         · ${m}`));
    cfg.poolId = credentials.poolId;
    record(
      'provision user pool + app client + user on cognitox',
      'PASS',
      `pool=${credentials.poolId} clientId=${credentials.clientId} secret=${mask(credentials.clientSecret)}`,
    );
  } catch (err) {
    record('provision user pool + app client + user on cognitox', 'FAIL', err.message);
    return finish();
  }

  // --- Discovery ----------------------------------------------------------
  check('discovery document reachable', () => {
    assert(cfg.discovery.authorization_endpoint, 'no authorization_endpoint');
    assert(cfg.discovery.token_endpoint, 'no token_endpoint');
    return `authz=${cfg.discovery.authorization_endpoint}`;
  });

  // --- Nonce proxy: route the OIDC flow through a local shim that adds the
  //     `nonce` cognitox omits, so the token->session step can complete. -----
  let proxy;
  try {
    proxy = await startNonceProxy({ upstream: cfg.cognitoxUrl, port: cfg.nonceProxyPort, otp: cfg.otpMode });
    cfg.oidcIssuer = proxy.issuer;
    record(
      'nonce proxy started (injects nonce into cognitox id_tokens)',
      'PASS',
      `${proxy.issuer} -> ${cfg.cognitoxUrl}${cfg.otpMode ? ' (OTP challenge mode ON)' : ''}`,
    );
  } catch (err) {
    record('nonce proxy started', 'FAIL', err.message);
    return finish();
  }

  // --- Runtime init + provider availability -------------------------------
  const app = Fastify({ logger: false });
  const identitySeen = [];
  const { runtime, integration } = buildAuthRuntime(cfg, credentials, {
    onIdentity: (i) => identitySeen.push(i),
  });
  await runtime.initialize();
  runtime.registerRoutes(app);
  await app.ready();

  await checkAsync('runtime initialized; cognito provider available', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/providers' });
    const body = res.json();
    const cognitoProvider = body.providers?.find((p) => p.id === 'cognito');
    assert(cognitoProvider, 'cognito provider not listed');
    assert(cognitoProvider.available === true, 'cognito provider is not available (discovery failed)');
    return `available=${cognitoProvider.available}`;
  });

  // --- Package behavior: validateRegistration warning ---------------------
  check('cognito().validateRegistration warns on non-AWS issuer', () => {
    const warnings = integration.validateRegistration?.({
      issuer: cfg.issuer,
      scopes: ['openid', 'email', 'profile'],
    });
    assert(Array.isArray(warnings), 'no warnings array returned');
    assert(
      warnings.some((w) => /Cognito IdP URL pattern/.test(w)),
      `expected issuer-pattern warning, got ${JSON.stringify(warnings)}`,
    );
    return `"${warnings[0]}"`;
  });

  // --- Package behavior: authorize redirect + PKCE ------------------------
  // With the nonce proxy in front, the authorize endpoint is the proxy's (which
  // transparently forwards to cognitox); without it, cognitox's directly.
  const expectedAuthz = cfg.oidcIssuer
    ? `${cfg.oidcIssuer}/oauth2/authorize`
    : cfg.discovery.authorization_endpoint;
  await checkAsync('login redirect targets authorize endpoint with PKCE', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/login/cognito?returnTo=/' });
    assert(res.statusCode === 302, `expected 302, got ${res.statusCode}`);
    const loc = new URL(res.headers.location);
    assert(loc.origin + loc.pathname === expectedAuthz, `wrong authorize endpoint: ${loc.origin}${loc.pathname}`);
    assert(loc.searchParams.get('client_id') === credentials.clientId, 'client_id mismatch');
    assert(loc.searchParams.get('redirect_uri') === cfg.callbackUrl, 'redirect_uri mismatch');
    assert(loc.searchParams.get('response_type') === 'code', 'response_type != code');
    assert(loc.searchParams.get('code_challenge_method') === 'S256', 'PKCE method != S256');
    assert(loc.searchParams.get('code_challenge'), 'missing code_challenge');
    assert(loc.searchParams.get('state'), 'missing state');
    assert(loc.searchParams.get('nonce'), 'missing nonce');
    assert(loc.searchParams.get('scope')?.includes('openid'), 'scope missing openid');
    return 'client_id, redirect_uri, PKCE S256, state, nonce all present';
  });

  // --- Package behavior: identity_provider allowlisting (hosted UI) --------
  const allowlisted = cfg.allowedIdps.find((i) => i !== 'COGNITO') ?? cfg.allowedIdps[0];
  await checkAsync(`identity_provider="${allowlisted}" forwarded to authorize URL`, async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/login/cognito?identity_provider=${encodeURIComponent(allowlisted)}`,
    });
    assert(res.statusCode === 302, `expected 302, got ${res.statusCode}`);
    const loc = new URL(res.headers.location);
    assert(
      loc.searchParams.get('identity_provider') === allowlisted,
      `identity_provider not forwarded (got ${loc.searchParams.get('identity_provider')})`,
    );
    return `authorize URL carries identity_provider=${allowlisted}`;
  });

  await checkAsync('non-allowlisted identity_provider is rejected (400)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/login/cognito?identity_provider=NotAllowed',
    });
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
    return 'blocked before redirect';
  });

  await checkAsync('unknown hosted-UI parameter is rejected (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/login/cognito?foo=bar' });
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
    return 'integration rejects unsupported params';
  });

  // --- Package behavior: buildProviderLogoutUrl ---------------------------
  check('cognito().buildProviderLogoutUrl builds federated logout URL', () => {
    const withDomain = cognito({ logout: { domain: 'https://demo.auth.us-east-1.amazoncognito.com' } });
    const url = withDomain.buildProviderLogoutUrl?.({
      metadata: {},
      clientId: credentials.clientId,
      logoutUri: `${cfg.applicationBaseUrl}/`,
    });
    assert(url, 'no URL built from configured https domain');
    assert(url.pathname === '/logout', `expected /logout, got ${url.pathname}`);
    assert(url.searchParams.get('client_id') === credentials.clientId, 'client_id missing');
    assert(url.searchParams.get('logout_uri') === `${cfg.applicationBaseUrl}/`, 'logout_uri missing');
    return `${url.origin}/logout?client_id=…&logout_uri=…`;
  });

  check('cognito().buildProviderLogoutUrl returns null for http origin', () => {
    const noHttps = cognito();
    const url = noHttps.buildProviderLogoutUrl?.({
      metadata: { endSessionEndpoint: 'http://localhost:9229/logout' },
      clientId: credentials.clientId,
      logoutUri: `${cfg.applicationBaseUrl}/`,
    });
    assert(url === null, `expected null for http, got ${url}`);
    return 'http hosted-UI logout is refused (https required)';
  });

  // --- cognitox nonce diagnostic ------------------------------------------
  let cognitoxEchoesNonce = false;
  await checkAsync('diagnostic: does cognitox echo the OIDC nonce claim?', async () => {
    const idClaims = await rawIdTokenClaims(cfg, credentials);
    cognitoxEchoesNonce = Object.prototype.hasOwnProperty.call(idClaims, 'nonce');
    const listed = (cfg.discovery.claims_supported ?? []).includes('nonce');
    return cognitoxEchoesNonce
      ? 'nonce present in id_token'
      : `nonce ABSENT in cognitox's own id_token (claims_supported lists nonce: ${listed}) — the nonce proxy injects it`;
  });

  // --- Full headless login: login -> (proxy -> cognitox) -> callback -> session
  //     Routed through the nonce proxy, so the session step now completes. -----
  await fullLogin(app, cfg, credentials, cognitoxEchoesNonce, identitySeen);

  await runtime.close?.();
  await app.close();
  await proxy.stop();
  return finish();

  async function checkAsync(name, fn) {
    try {
      const detail = await fn();
      record(name, 'PASS', detail || '');
      return true;
    } catch (err) {
      record(name, 'FAIL', err.message);
      return false;
    }
  }
}

/** Raw authorize+token round-trip (bypassing plumbus) to inspect id_token claims. */
async function rawIdTokenClaims(cfg, credentials) {
  const { verifier, challenge } = pkce();
  const authz = new URL(cfg.discovery.authorization_endpoint);
  const params = {
    response_type: 'code',
    client_id: credentials.clientId,
    redirect_uri: cfg.callbackUrl,
    scope: 'openid email profile',
    state: randomBytes(8).toString('hex'),
    nonce: randomBytes(8).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    username: cfg.username,
    password: cfg.password,
  };
  for (const [k, v] of Object.entries(params)) authz.searchParams.set(k, v);
  const redir = await fetch(authz.toString(), { redirect: 'manual' });
  const loc = redir.headers.get('location');
  if (!loc) throw new Error(`cognitox authorize did not redirect (HTTP ${redir.status})`);
  const code = new URL(loc).searchParams.get('code');
  if (!code) throw new Error('cognitox authorize returned no code');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.callbackUrl,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code_verifier: verifier,
  });
  const tok = await fetch(cfg.discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = await tok.json();
  if (!body.id_token) throw new Error(`token endpoint returned no id_token: ${JSON.stringify(body)}`);
  const payload = body.id_token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

/**
 * OTP mode: the proxy withholds the authorization code behind a one-time-code
 * challenge. Assert the challenge appears, a wrong code is rejected, and the
 * right code (read from the proxy's test endpoint) releases the callback
 * redirect. Returns the released redirect location, or null.
 */
async function passOtpChallenge(cx, cfg) {
  const html = await cx.text();
  const presented = cx.status === 200 && html.includes('action="/otp/verify"');
  record(
    'otp: challenge page presented before code release',
    presented ? 'PASS' : 'FAIL',
    presented ? 'authorize returned a challenge instead of the code' : `expected challenge page, got HTTP ${cx.status}`,
  );
  if (!presented) return null;

  const { cid, code: otpCode } = await (await fetch(`${cfg.oidcIssuer}/otp/last`)).json();
  const wrong = otpCode === '000000' ? '111111' : '000000';
  const bad = await fetch(`${cfg.oidcIssuer}/otp/verify?cid=${cid}&code=${wrong}`, { redirect: 'manual' });
  const badBody = await bad.text();
  record(
    'otp: wrong code re-challenges without releasing the code',
    bad.status === 200 && badBody.includes('Incorrect code') && !bad.headers.get('location') ? 'PASS' : 'FAIL',
    `status=${bad.status}`,
  );

  const good = await fetch(`${cfg.oidcIssuer}/otp/verify?cid=${cid}&code=${otpCode}`, { redirect: 'manual' });
  const loc = good.headers.get('location');
  record(
    'otp: correct code releases the authorization code',
    loc?.includes('code=') ? 'PASS' : 'FAIL',
    loc ? 'challenge passed; redirected to callback' : `no redirect (status=${good.status})`,
  );
  return loc;
}

/** Drive the full browserless flow and classify the outcome. */
async function fullLogin(app, cfg, credentials, cognitoxEchoesNonce, identitySeen) {
  let code;
  let binding;
  try {
    const login = await app.inject({ method: 'GET', url: '/auth/login/cognito?returnTo=/' });
    binding = String(login.headers['set-cookie'] ?? '').split(';')[0];
    const authz = new URL(login.headers.location);
    authz.searchParams.set('username', cfg.username);
    authz.searchParams.set('password', cfg.password);
    const cx = await fetch(authz.toString(), { redirect: 'manual' });
    let loc = cx.headers.get('location');
    if (cfg.otpMode) {
      loc = await passOtpChallenge(cx, cfg);
    }
    code = loc ? new URL(loc) : null;
    record(
      'full login: cognitox issues an authorization code',
      code?.searchParams.get('code') ? 'PASS' : 'FAIL',
      code?.searchParams.get('code') ? 'code returned to callback URL' : `no code (HTTP ${cx.status})`,
    );
  } catch (err) {
    record('full login: cognitox issues an authorization code', 'FAIL', err.message);
    return;
  }
  if (!code?.searchParams.get('code')) return;

  const cb = await app.inject({
    method: 'GET',
    url: `${code.pathname}${code.search}`,
    headers: { cookie: binding },
  });
  const sessionCookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  const established = cb.statusCode === 303 && /plumbus/.test(sessionCookie);

  if (established) {
    const sess = (await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: sessionCookie } })).json();
    record(
      'full login: session established (callback → /auth/session)',
      sess.authenticated ? 'PASS' : 'FAIL',
      sess.authenticated
        ? `userId=${sess.user?.userId} roles=${JSON.stringify(sess.user?.roles)} groups=${JSON.stringify(identitySeen.at(-1)?.groups)}`
        : 'session not authenticated',
    );
    if (sess.authenticated) {
      const lo = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: sessionCookie, origin: cfg.applicationBaseUrl, 'x-csrf-token': sess.csrfToken },
      });
      record('full login: logout clears session (200 + loggedOut)', lo.statusCode === 200 && lo.json().loggedOut ? 'PASS' : 'FAIL', `status=${lo.statusCode}`);
    }
    return;
  }

  // Callback failed even with the nonce proxy in front — that's a real failure now.
  const errCode = new URL(cb.headers.location ?? 'http://x/login-error', 'http://x').searchParams.get('code');
  record(
    'full login: session established (callback → /auth/session)',
    'FAIL',
    `callback error=${errCode ?? 'login_failed'} status=${cb.statusCode}` +
      (cognitoxEchoesNonce ? '' : ' (nonce proxy did not inject nonce as expected)'),
  );
}

function finish() {
  const fails = results.filter((r) => r.status === 'FAIL');
  const blocked = results.filter((r) => r.status === 'BLOCKED');
  const passes = results.filter((r) => r.status === 'PASS');
  console.log('\n' + '='.repeat(38));
  console.log(`Summary: ${passes.length} passed, ${fails.length} failed, ${blocked.length} blocked`);
  if (blocked.length) {
    console.log('\nBLOCKED (environment limitation, not a package defect):');
    for (const b of blocked) console.log(`  · ${b.name}\n    ${b.detail}`);
  }
  if (fails.length) {
    console.log('\nFAILED:');
    for (const f of fails) console.log(`  · ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll required checks passed. ✅');
  }
}

main().catch((err) => {
  console.error('\nfatal:', err.stack ?? err.message);
  process.exit(1);
});
