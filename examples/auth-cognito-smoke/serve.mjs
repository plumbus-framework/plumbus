// Interactive smoke server for @plumbus/auth-cognito against a running cognitox.
//
//   PORT=... node serve.mjs      # then open the printed URL
//
// Boots a single-origin Fastify app that hosts a landing page plus the real
// @plumbus/auth /auth/* routes wired to cognitox via the cognito() integration.
// Click "Sign in", authenticate at cognitox's hosted UI with the seeded
// credentials, and land back here with a real session. The OIDC flow is routed
// through a local nonce proxy (lib/nonce-proxy.mjs) that adds the `nonce` claim
// cognitox omits, so login completes end to end.
import { Fastify } from './lib/deps.mjs';
import { loadConfig, mask } from './lib/config.mjs';
import { startNonceProxy } from './lib/nonce-proxy.mjs';
import { buildAuthRuntime, resolveCredentials } from './lib/runtime.mjs';
import { registerAttestedRoutes, startAttestedDemo } from './lib/attested.mjs';

const cfg = await loadConfig();

console.log('\n@plumbus/auth-cognito — interactive smoke server');
console.log('='.repeat(48));
for (const w of cfg.warnings) console.log(`\n⚠  ${w}\n`);

const credentials = await resolveCredentials(cfg, (m) => console.log(`· ${m}`));
cfg.poolId = credentials.poolId;

// Route the OIDC flow through the local nonce proxy so login reaches a session.
const proxy = await startNonceProxy({
  upstream: cfg.cognitoxUrl,
  port: cfg.nonceProxyPort,
  otp: cfg.otpMode,
});
cfg.oidcIssuer = proxy.issuer;
console.log(`· nonce proxy ${proxy.issuer} -> ${cfg.cognitoxUrl}`);
if (cfg.otpMode) console.log('· OTP mode ON — one-time codes will print in this terminal');

const app = Fastify({ logger: false });
const { runtime } = buildAuthRuntime(cfg, credentials, {
  onIdentity: (i) => console.log(`· resolveIdentity: sub=${i.subject} groups=${JSON.stringify(i.groups)}`),
});
await runtime.initialize();
runtime.registerRoutes(app);

// Server-attested sign-in (magic link → Cognito) against the in-process fake Cognito.
const attested = await startAttestedDemo({ log: (m) => console.log(`· attested: ${m}`) });
registerAttestedRoutes(app, attested);

app.get('/', async (_req, reply) => {
  reply.type('text/html').send(landingPage(cfg, credentials, attested.describe()));
});

app.get('/login-error', async (req, reply) => {
  const q = req.query ?? {};
  reply.type('text/html').send(errorPage(q.code, q.requestId));
});

app.get('/healthz', async () => ({ ok: true }));

await app.listen({ host: '0.0.0.0', port: cfg.port });

console.log('\nReady.');
console.log(`  Open       ${cfg.externalBaseUrl}`);
console.log(`  Sign in    ${cfg.externalBaseUrl}/auth/login/cognito`);
console.log(`  Seeded user  ${cfg.username}  /  ${cfg.password}`);
console.log(`  Client     ${credentials.clientId}  (secret ${mask(credentials.clientSecret)})`);
console.log('\nPress Ctrl+C to stop.');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await runtime.close?.();
    await app.close();
    await proxy.stop();
    await attested.close();
    process.exit(0);
  });
}

// --- pages -----------------------------------------------------------------

function landingPage(cfg, credentials, attestedPool) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>@plumbus/auth-cognito smoke</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px;
    background: Canvas; color: CanvasText; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin: 0 0 8px; } code { background: #8883; padding: 1px 5px; border-radius: 4px; }
  .card { border: 1px solid #8884; border-radius: 10px; padding: 18px 20px; margin: 16px 0; }
  a.btn, button { display: inline-block; background: #2563eb; color: #fff; border: 0;
    padding: 10px 16px; border-radius: 8px; text-decoration: none; font: inherit; cursor: pointer; }
  button.secondary { background: #64748b; }
  pre { background: #8881; padding: 12px; border-radius: 8px; overflow: auto; }
  .warn { border-left: 3px solid #d97706; padding-left: 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
  dt { color: #888; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .alert { color: #b91c1c; font-weight: 600; }
  input[type=email] { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid #8886; min-width: 260px; }
</style></head><body>
<h1>@plumbus/auth-cognito · smoke</h1>
<p>Exercises the <code>cognito()</code> integration through a real <code>@plumbus/auth</code>
runtime pointed at your cognitox emulator.</p>

<div class="card">
  <dl>
    <dt>cognitox</dt><dd><code>${esc(cfg.cognitoxUrl)}</code></dd>
    <dt>issuer</dt><dd><code>${esc(cfg.issuer)}</code></dd>
    <dt>nonce proxy</dt><dd><code>${esc(cfg.oidcIssuer ?? '(off)')}</code></dd>
    <dt>otp mode</dt><dd><code>${cfg.otpMode ? 'ON — code prints in the server terminal' : 'off'}</code></dd>
    <dt>user pool</dt><dd><code>${esc(cfg.poolId)}</code></dd>
    <dt>app client</dt><dd><code>${esc(credentials.clientId)}</code></dd>
    <dt>seeded user</dt><dd><code>${esc(cfg.username)}</code> / <code>${esc(cfg.password)}</code></dd>
  </dl>
</div>

<div class="card">
  <p><a class="btn" href="/auth/login/cognito?returnTo=/">Sign in with Cognito →</a></p>
  <div id="session">Checking session…</div>
</div>


<div class="card" id="attested">
  <h2>Server-attested sign-in · magic link → Cognito</h2>
  <p>The app authenticates the person with its own single-use link, then
  <code>@plumbus/auth-cognito/server</code> signs their account into a Cognito pool through
  custom auth, answering the trigger's nonce with an HMAC attestation. cognitox has no custom
  auth, so this pool lives in the package's in-process fake Cognito, which runs the real
  <code>createAttestedSignInTrigger</code>.</p>
  <dl>
    <dt>fake Cognito</dt><dd><code>${esc(attestedPool.endpoint)}</code></dd>
    <dt>attested pool</dt><dd><code>${esc(attestedPool.userPoolId)}</code></dd>
    <dt>app client</dt><dd><code>${esc(attestedPool.clientId)}</code> (no secret, custom auth only)</dd>
    <dt>issuer</dt><dd><code>${esc(attestedPool.issuer)}</code></dd>
  </dl>
  <p id="attested-error" class="alert" role="alert"></p>
  <form id="attested-form" class="row">
    <input name="email" type="email" aria-label="Email" value="member@tenant-a.example" required />
    <button type="submit">Email me a sign-in link</button>
  </form>
  <div id="attested-link"></div>
  <div id="attested-session">Checking attested session…</div>
  <div class="row">
    <button type="button" class="secondary" data-admin="disable">Disable user in pool</button>
    <button type="button" class="secondary" data-admin="enable">Enable user</button>
    <button type="button" class="secondary" data-admin="outage-on">Simulate Cognito outage</button>
    <button type="button" class="secondary" data-admin="outage-off">End outage</button>
  </div>
  <p id="attested-admin"></p>
</div>

<div class="card warn">
  <strong>About the <code>nonce</code> proxy.</strong>
  <p>Stock cognitox does not echo the OIDC <code>nonce</code> claim in id_tokens, which
  <code>@plumbus/auth</code> requires. This app routes the OIDC flow through a small local
  proxy (<code>lib/nonce-proxy.mjs</code>, Node built-ins only) that re-signs cognitox's
  id_token with the <code>nonce</code> added — so sign-in completes to a real session.
  cognitox stays the backend: real hosted UI, <code>cognito:groups</code>, admin API.
  Run <code>node check.mjs</code> for the full pass/fail report.</p>
</div>

<script>
async function refresh() {
  const el = document.getElementById('session');
  const r = await fetch('/auth/session', { credentials: 'include' });
  const s = await r.json();
  if (!s.authenticated) { el.innerHTML = '<em>Not signed in.</em>'; return; }
  el.innerHTML = '<strong>Signed in</strong><pre>' +
    JSON.stringify(s.user, null, 2) + '</pre>' +
    '<button class="secondary" id="lo">Log out</button>';
  document.getElementById('lo').onclick = async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include',
      headers: { 'x-csrf-token': s.csrfToken } });
    refresh();
  };
}
refresh();

const post = (url, body) => fetch(url, { method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const emailInput = document.querySelector('#attested-form input[name=email]');
const attestedError = new URLSearchParams(location.search).get('attestedError');
if (attestedError) document.getElementById('attested-error').textContent =
  'Attested sign-in refused: ' + attestedError;
async function attestedRefresh() {
  const el = document.getElementById('attested-session');
  const s = await (await fetch('/attested/session', { credentials: 'include' })).json();
  if (!s.authenticated) { el.innerHTML = '<em>Not signed in (attested).</em>'; return; }
  el.innerHTML = '<strong>Signed in through Cognito</strong><pre>' +
    JSON.stringify(s, null, 2).replace(/</g, '&lt;') + '</pre>' +
    '<button class="secondary" id="attested-logout">Log out (attested)</button>';
  document.getElementById('attested-logout').onclick = async () => {
    await post('/attested/logout');
    attestedRefresh();
  };
}
document.getElementById('attested-form').onsubmit = async (event) => {
  event.preventDefault();
  const r = await post('/attested/request', { email: emailInput.value });
  const body = await r.json();
  const out = document.getElementById('attested-link');
  if (!r.ok) { out.textContent = 'Refused: ' + body.error; return; }
  out.innerHTML = '<p>Sign-in link (a real app would email this; valid ' + body.expiresInSeconds +
    ' s, single use):<br><a id="attested-open" href="' + body.link + '">Open sign-in link</a></p>';
};
for (const button of document.querySelectorAll('[data-admin]')) {
  button.onclick = async () => {
    const r = await post('/attested/admin', { action: button.dataset.admin, email: emailInput.value });
    document.getElementById('attested-admin').textContent =
      button.textContent + ': ' + JSON.stringify(await r.json());
  };
}
attestedRefresh();
</script>
</body></html>`;
}

function errorPage(code, requestId) {
  // serve.mjs always routes the OIDC flow through the nonce proxy, so a missing
  // nonce is no longer the likely cause of login_failed; name the real ones.
  const isLoginFailed = code === 'login_failed';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Login error</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;background:Canvas;color:CanvasText}
code{background:#8883;padding:1px 5px;border-radius:4px}
.warn{border-left:3px solid #d97706;padding-left:12px}</style></head><body>
<h1>Login did not complete</h1>
<p>Error code: <code>${esc(code ?? 'unknown')}</code>${requestId ? ` · request <code>${esc(requestId)}</code>` : ''}</p>
${
  isLoginFailed
    ? `<div class="warn"><p><code>@plumbus/auth</code> refused the callback. The usual causes are a
       login transaction that expired, was already used, or was started in another browser, a
       forged or mismatched <code>state</code>, or an authorization code Cognito rejected. The
       request id above matches the server's audit entry.</p></div>`
    : ''
}
<p><a href="/">← Back</a></p>
</body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
