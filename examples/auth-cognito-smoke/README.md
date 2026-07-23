# `@plumbus/auth-cognito` smoke app

A self-contained smoke test for **`@plumbus/auth-cognito`** that drives the
`cognito()` integration through a real **`@plumbus/auth`** OIDC runtime pointed at
a local [**cognitox**](https://github.com/unvalley/cognitox) emulator.

It is **not** part of the pnpm workspace and installs nothing: it imports the
already-built `dist/` of `@plumbus/auth` and `@plumbus/auth-cognito`, and resolves
`fastify` from the auth package's own `node_modules`. It lives outside the pnpm
workspace and any published package, so it never affects `build`, `test`, `lint`,
`typecheck`, or `publish`.

## What it verifies

Everything the `cognito()` integration contributes, against a live emulator:

| Area | Check |
|---|---|
| Discovery | OpenID config reachable; provider becomes `available` after `initialize()` |
| `validateRegistration` | Warns that cognitox's non-AWS issuer doesn't match the Cognito IdP URL pattern |
| `authorizationParams` | `/auth/login/cognito` → 302 to cognitox authorize with `client_id`, `redirect_uri`, PKCE `S256`, `state`, `nonce` |
| Hosted-UI allowlist | Allowlisted `identity_provider` is forwarded; non-allowlisted and unknown params are rejected (400) |
| `buildProviderLogoutUrl` | Builds `/logout?client_id=…&logout_uri=…` for an HTTPS hosted-UI domain; returns `null` for http |
| Full login → session | Drives cognitox's hosted UI headlessly to a code, runs the `@plumbus/auth` callback, and asserts an authenticated session + logout (completes via the nonce proxy below) |
| OTP (simulated, opt-in) | With `OTP_MODE=1`, a one-time-code challenge is inserted mid-login; asserts the challenge gates the code, wrong codes are rejected, and the RP's login transaction survives the multi-step flow |

## Prerequisites

1. **cognitox running.** Docker: `docker run -p 9229:9229 ghcr.io/unvalley/cognitox:latest`
   (or the project's `docker-compose.yml`). No pool setup required — the app creates it.
2. **Framework packages built** (the app imports their `dist/`):
   ```bash
   # from the repo root
   turbo run build --filter=@plumbus/auth-cognito
   ```

The app **auto-provisions** everything a login needs, idempotently, via cognitox's
open admin API: a **user pool** (found or created by name; override with
`COGNITO_USER_POOL_ID`), a confidential **app client** (secret, code grant, PKCE,
`openid email profile` scopes, callback = `{EXTERNAL_BASE_URL}/auth/callback/cognito`),
and a confirmed **user** with a known password. Re-runs reuse them. Set
`AUTO_PROVISION=0` to instead supply `COGNITO_CLIENT_ID` / `COGNITO_CLIENT_SECRET`
yourself. Undo everything by deleting the pool, or wiping cognitox's data file
(the `./.cognito` volume in the compose setup).

## Run

```bash
cd examples/auth-cognito-smoke

# Automated pass/fail battery (no browser). Exit code != 0 on a real failure.
node check.mjs

# Interactive server — open http://localhost:3000 and click "Sign in".
node serve.mjs
```

## The nonce proxy

Stock cognitox does **not** echo the OIDC `nonce` claim in its id_tokens (its
discovery `claims_supported` omits `nonce`). `@plumbus/auth` always sends a `nonce`
on the authorize request and rejects an id_token whose `nonce` doesn't match — so a
raw cognitox login dies at id_token validation (`login_failed`).

To close that one gap **without** forking cognitox or leaving Cognito behind, the
app routes the OIDC flow through a small local proxy — [`lib/nonce-proxy.mjs`](./lib/nonce-proxy.mjs),
**Node built-ins only, nothing installed**:

```
@plumbus/auth  ──►  nonce-proxy (127.0.0.1:9301)  ──►  cognitox
```

- `/.well-known/openid-configuration` — cognitox's doc, with `issuer` + authorize/
  token/jwks pointed at the proxy.
- `/oauth2/authorize` — transparently forwarded to cognitox; the proxy remembers
  `code → nonce`.
- `/oauth2/token` — forwarded to cognitox, then the proxy adds the remembered
  `nonce`, sets `iss` to itself, and **re-signs** the id_token with its own key
  (served at `/oauth2/jwks`).

cognitox stays the real backend — real hosted UI, `cognito:groups`, cognito-idp
admin API — so the Cognito-specific behavior is genuinely exercised; only the
missing `nonce` is patched in transit. With it, `check.mjs` reports the full
`login → session → logout` as **PASS**. `@plumbus/auth` is never weakened: it still
strictly requires `nonce`; the proxy just makes the emulator honest.

> The clean long-term fix is upstream: cognitox should echo `nonce` (a ~3-line
> change). When it does, drop the proxy and point the `cognito` provider straight
> at cognitox.

## Simulated OTP mode (opt-in)

No local emulator implements Cognito's passwordless Email/SMS OTP (cognitox
returns `NotImplementedException` for the `USER_AUTH` flow and has no Lambda
triggers; LocalStack's Cognito is paid and has the same missing-`nonce` bug). So
`OTP_MODE=1` makes the **proxy** simulate the challenge step instead:

```bash
OTP_MODE=1 node check.mjs   # adds 3 otp checks to the battery
OTP_MODE=1 node serve.mjs   # browser flow shows an "Enter code" page mid-login
```

After cognitox accepts the password, the proxy withholds the authorization code
behind a one-time-code page. The code is **printed to the terminal** (emulator-
style delivery — cognitox itself only logs its codes) and exposed at
`/otp/last` so `check.mjs` can drive it headlessly. Wrong codes re-challenge
(max 5 attempts); the right code releases the callback redirect.

Scope honesty: this exercises the **RP** under a multi-step, interrupted hosted
login — proving `@plumbus/auth`'s state/PKCE/binding-cookie transaction survives
it — plus the OTP UX in `serve.mjs`. It does **not** test Cognito's real OTP
implementation; only the live AWS service runs that code.

## Host / issuer matching

`@plumbus/auth` requires the configured issuer to **exactly** equal the issuer in
the discovery document, and it performs discovery + token exchange against that
issuer. cognitox advertises its issuer from `COGNITOX_ISSUER_BASE_URL`. The app
reads the issuer from discovery, so `COGNITOX_URL` must point at the host named by
that issuer — otherwise discovery/token calls won't resolve. The app warns loudly
when the two hosts differ.

Two working setups:

- **localhost (default, single machine).** Run cognitox with the default issuer
  (`http://localhost:9229`) and the app on the same host — no config needed.
- **Another host (e.g. a LAN box).** Start cognitox with
  `COGNITOX_ISSUER_BASE_URL=http://<that-host>:9229` so the advertised issuer is
  reachable, then set `COGNITOX_URL` to the same address (in `.env` or the shell).

Configure via a `.env` file (copy `.env.example` → `.env`; it's loaded
automatically and gitignored) or by exporting the vars in your shell.

Because the issuer is http, the runtime runs in `development` mode (which permits
insecure OIDC endpoints).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `COGNITOX_URL` | `http://localhost:9229` | Where discovery + the admin API are reached (match the issuer host) |
| `COGNITO_USER_POOL_ID` | *(auto)* | Use a specific pool; unset ⇒ find/create by `COGNITO_POOL_NAME` |
| `COGNITO_POOL_NAME` | `plumbus-auth-cognito-smoke` | Pool name to find/create when no id is given |
| `PORT` | `3000` | Port for `serve.mjs` |
| `EXTERNAL_BASE_URL` | `http://localhost:{PORT}` | Public base URL (drives the callback URL) |
| `ALLOWED_IDPS` | `COGNITO,Google` | Hosted-UI `identity_provider` allowlist |
| `SMOKE_USERNAME` / `SMOKE_PASSWORD` | `smoke@example.com` / `SmokeTest123!` | Seeded login user |
| `SMOKE_CLIENT_NAME` | `plumbus-auth-cognito-smoke` | App client name to create/reuse |
| `PROVIDER_LOGOUT_DOMAIN` | *(empty)* | Optional HTTPS hosted-UI domain for federated logout |
| `NONCE_PROXY_PORT` | `9301` | Local port for the nonce proxy |
| `OTP_MODE` | `0` | Set `1` to insert a simulated one-time-code challenge mid-login |
| `AUTO_PROVISION` | `1` | Set `0` to use `COGNITO_CLIENT_ID` / `COGNITO_CLIENT_SECRET` instead |

## Files

| File | Purpose |
|---|---|
| `check.mjs` | Automated pass/fail smoke battery |
| `serve.mjs` | Interactive server (landing page + `/auth/*` + session panel) |
| `lib/deps.mjs` | Loads built `dist/` + fastify without touching the workspace |
| `lib/config.mjs` | Env + discovery → resolved config (with issuer/host warnings) |
| `lib/cognitox-admin.mjs` | cognito-idp admin client + idempotent provisioning |
| `lib/runtime.mjs` | Builds the `@plumbus/auth` runtime with the `cognito()` integration |
| `lib/nonce-proxy.mjs` | Local dependency-free proxy that injects the OIDC `nonce` cognitox omits; optional simulated OTP challenge (`OTP_MODE=1`) |
