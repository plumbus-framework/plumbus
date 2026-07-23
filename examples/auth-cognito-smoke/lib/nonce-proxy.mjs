// Local, dependency-free shim that makes cognitox spec-complete on the OIDC
// `nonce` claim. cognitox drives the whole Cognito login correctly but omits
// `nonce` from its id_tokens, which @plumbus/auth (correctly) rejects. This proxy
// sits between the RP and cognitox:
//
//   @plumbus/auth  ──►  nonce-proxy (this)  ──►  cognitox
//
// - /.well-known/openid-configuration : cognitox's doc, with issuer + authorize/
//   token/jwks pointed at the proxy (so the flow routes through here).
// - /oauth2/authorize : transparently forwarded to cognitox; when cognitox
//   redirects back with a `code`, we remember code → nonce (from the request).
// - /oauth2/token : forwarded to cognitox, then we take cognitox's id_token, add
//   the remembered `nonce`, set `iss` to the proxy, and RE-SIGN it with our own
//   key (served at /oauth2/jwks) so the RP can verify it.
// - anything else (userinfo, hosted-UI assets) : transparent pass-through.
//
// Optional OTP challenge mode (`otp: true`): after cognitox accepts the user's
// credentials, the proxy withholds the authorization code behind a one-time-code
// challenge page. The code is printed to the terminal (emulator-style delivery —
// cognitox itself only logs its codes) and exposed at /otp/last for headless
// tests. This simulates a multi-step hosted-UI login (like Cognito's Email OTP)
// so the RP's login transaction — state, PKCE verifier, binding cookie — is
// exercised across an interrupted, multi-request authorize. It does NOT test
// Cognito's real OTP implementation; no local emulator supports that.
//
// Uses only Node built-ins: node:http, node:crypto, global fetch. No installs.
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, randomInt, sign as rsaSign } from 'node:crypto';

const HOP_BY_HOP = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection']);
const b64url = (input) => Buffer.from(input).toString('base64url');

/**
 * Start the nonce-injecting proxy.
 * @param {{ upstream: string, port?: number, otp?: boolean }} opts
 * @returns {Promise<{ issuer: string, stop: () => Promise<void> }>}
 */
export async function startNonceProxy({ upstream, port = 9301, otp = false }) {
  const base = upstream.replace(/\/$/, '');
  const issuer = `http://127.0.0.1:${port}`; // 127.0.0.1: matches @plumbus/auth's dev http allowance

  // Our RS256 key: cognitox's original signature is discarded; we re-sign.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' })), kid: 'nonce-proxy', use: 'sig', alg: 'RS256' };

  const codeToNonce = new Map();
  // OTP mode: cid -> { location (held callback redirect), code, attempts }.
  // Test shim only — unbounded growth is fine for a smoke run.
  const otpChallenges = new Map();
  let lastChallenge = null;
  let discoveryDoc;

  async function discovery() {
    if (!discoveryDoc) {
      const up = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
      discoveryDoc = {
        ...up,
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        jwks_uri: `${issuer}/oauth2/jwks`,
      };
    }
    return discoveryDoc;
  }

  function resignIdToken(originalJwt, nonce) {
    const payload = JSON.parse(Buffer.from(originalJwt.split('.')[1], 'base64url').toString());
    payload.nonce = nonce;
    payload.iss = issuer; // must equal the discovery issuer the RP validates against
    const header = { alg: 'RS256', typ: 'JWT', kid: jwk.kid };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = rsaSign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  function otpPage(cid, error = '') {
    return `<!doctype html><html><head><title>One-time code</title><style>
body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);width:300px}
h1{margin:0 0 8px;font-size:22px;text-align:center}p{color:#555;font-size:13px;text-align:center}
input{width:100%;padding:12px;margin:8px 0;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:18px;letter-spacing:4px;text-align:center}
button{width:100%;padding:12px;background:#007bff;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:16px}
.e{color:#dc3545;text-align:center;margin-top:10px;font-size:13px}</style></head><body><div class="c">
<h1>Enter code</h1>
<p>A one-time code was "sent" — it is printed in the terminal running the smoke app.</p>
<form method="GET" action="/otp/verify">
<input type="hidden" name="cid" value="${cid}">
<input type="text" name="code" placeholder="6-digit code" autocomplete="one-time-code" required autofocus>
<button type="submit">Verify</button>
</form>${error ? `<div class="e">${error}</div>` : ''}
</div></body></html>`;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  }

  function relay(res, upRes, buf, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    upRes.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key) && !(key in headers)) headers[key] = value;
    });
    res.writeHead(upRes.status, headers);
    res.end(buf);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, issuer);
      const path = url.pathname;

      if (path === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(await discovery()));
        return;
      }

      if (path === '/oauth2/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }

      if (path === '/oauth2/authorize') {
        const upRes = await fetch(`${base}/oauth2/authorize${url.search}`, {
          method: req.method,
          redirect: 'manual',
        });
        // When cognitox redirects back with a code, remember which nonce it belongs to.
        const location = upRes.headers.get('location');
        const nonce = url.searchParams.get('nonce');
        const grantedCode = location ? new URL(location, base).searchParams.get('code') : null;
        if (grantedCode && nonce) codeToNonce.set(grantedCode, nonce);

        // OTP mode: withhold the code behind a one-time-code challenge.
        if (otp && grantedCode) {
          const cid = randomBytes(8).toString('hex');
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          otpChallenges.set(cid, { location, code, attempts: 0 });
          lastChallenge = { cid, code };
          console.log(`[nonce-proxy] OTP challenge ${cid} — one-time code: ${code}`);
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(otpPage(cid));
          return;
        }
        relay(res, upRes, Buffer.from(await upRes.arrayBuffer()));
        return;
      }

      if (otp && path === '/otp/verify') {
        const cid = url.searchParams.get('cid') ?? '';
        const supplied = url.searchParams.get('code') ?? '';
        const challenge = otpChallenges.get(cid);
        if (!challenge) {
          res.writeHead(410, { 'content-type': 'text/html' });
          res.end(otpPage('', 'Challenge expired — start the login again.'));
          return;
        }
        challenge.attempts += 1;
        if (challenge.attempts > 5) {
          otpChallenges.delete(cid);
          res.writeHead(410, { 'content-type': 'text/html' });
          res.end(otpPage('', 'Too many attempts — start the login again.'));
          return;
        }
        if (supplied !== challenge.code) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(otpPage(cid, 'Incorrect code — try again.'));
          return;
        }
        otpChallenges.delete(cid);
        res.writeHead(302, { location: challenge.location });
        res.end();
        return;
      }

      // Test-only helper so headless checks can read the current code.
      if (otp && path === '/otp/last') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(lastChallenge ?? {}));
        return;
      }

      if (path === '/oauth2/token') {
        const body = await readBody(req);
        const upRes = await fetch(`${base}/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded' },
          body,
        });
        const json = await upRes.json();
        if (upRes.ok && json.id_token) {
          const code = new URLSearchParams(body).get('code');
          const nonce = code ? codeToNonce.get(code) : undefined;
          if (nonce) {
            json.id_token = resignIdToken(json.id_token, nonce);
            codeToNonce.delete(code);
          }
        }
        res.writeHead(upRes.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
        return;
      }

      // Transparent pass-through (userinfo, hosted-UI assets, etc.)
      const init = { method: req.method, redirect: 'manual', headers: {} };
      if (req.headers.authorization) init.headers.authorization = req.headers.authorization;
      if (req.headers['content-type']) init.headers['content-type'] = req.headers['content-type'];
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await readBody(req);
      const upRes = await fetch(`${base}${path}${url.search}`, init);
      relay(res, upRes, Buffer.from(await upRes.arrayBuffer()));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nonce_proxy_error', message: String(err?.message ?? err) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    issuer,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
