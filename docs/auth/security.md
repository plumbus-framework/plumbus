# Auth Security

**Previous:** [cognito.md](./cognito.md) · **Next:** [testing.md](./testing.md)

Security properties of `@plumbus/auth` and how they compose with Plumbus deny-by-default access policies.

---

## Threat model summary

| Asset | Protection |
|---|---|
| Session identifier | Opaque random token; store holds HMAC hash only |
| Principal payload (userId, issuer, subject) | Envelope encryption via `storageProtection` |
| CSRF token | Stored as hash; compared timing-safe on mutating requests |
| Login state (PKCE verifier, nonce) | Short-lived transaction rows; browser binding cookie |
| OIDC tokens | Used during callback only — not stored in session cookie |

Authorization (**roles/scopes/tenant**) is re-resolved on **every request** via `resolveAuthorization`. Changing group membership in your directory takes effect on the next HTTP call (subject to resolver caching you add in app code).

This runtime follows [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700) (OAuth 2.0 Security BCP, Jan 2025) for authorization-code flows: PKCE for all clients, one-time state, mix-up defenses (`iss` validation + per-provider callback paths), exact redirect URIs, and no implicit or ROPC grants.

---

## Frontend XSS and Content-Security-Policy

**This session model assumes the frontend is free of cross-site scripting (XSS).** Deploy a strong **Content-Security-Policy** and treat XSS prevention as a load-bearing security control — not an optional hardening step.

The BFF / cookie-session pattern shifts the primary browser threat from **token theft** (bearer in `localStorage`) to **same-origin request forgery via XSS**:

| What HttpOnly protects | What it does *not* protect |
|---|---|
| Session cookie value — JavaScript cannot read it | Same-origin script reading **`csrfToken`** from `/auth/session` JSON |
| OIDC tokens — never stored in cookies | Same-origin script calling mutating APIs with **`credentials: 'include'`** + **`X-CSRF-Token`** |

`GET /auth/session` returns the CSRF token to same-origin JavaScript because the SPA must attach it on unsafe methods. An XSS payload can fetch that token and issue fully authenticated, CSRF-valid requests. **XSS therefore defeats CSRF** — this is inherent to the architecture, not a bypass bug.

Mitigations:

- **CSP** — restrict script sources; avoid inline script where possible; use nonces/hashes when inline is required.
- **Keep `csrfToken` in memory** — never `localStorage` or `sessionStorage` (generated clients and docs assume this).
- **Sanitize rendered HTML** and audit third-party script tags.
- **HttpOnly session cookies** still matter — they prevent direct cookie exfiltration to a cross-origin attacker without XSS.

See [sessions-and-csrf.md](./sessions-and-csrf.md) for the browser contract.

---

## OIDC protocol

- **Authorization code + PKCE (S256)** for all providers
- State parameter bound to login transaction row
- ID token validated against issuer JWKS at callback
- Optional UserInfo fetch when `fetchUserInfo: true`

Integrations may add query params but **cannot** skip signature or issuer checks.

---

## Cookie and transport

Production session cookies match the [OAuth 2.0 for Browser-Based Apps](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps) BFF requirements:

| Property | Value |
|---|---|
| `Secure` | Required in production (HTTPS) |
| `HttpOnly` | Always |
| `Path` | `/` |
| `Domain` | Omitted — **`__Host-` prefix** enforces host-only cookies |
| Prefix | `__Host-` in production (`session.cookieName`, default `__Host-plumbus_session`) |

### SameSite (default Lax, Strict opt-in)

The Browser-Based Apps BCP recommends **`SameSite=Strict`** for BFF session cookies. This runtime defaults to **`SameSite=Lax`**:

- **Why Lax is default:** Inbound top-level navigations (deep links, some split-origin layouts) and cross-site API/SPA combinations often need the session cookie on safe cross-site GETs. Lax preserves those flows.
- **Compensation:** Mutating requests require a session-bound **`X-CSRF-Token`** plus **`Origin`** validation against `applicationBaseUrl` — an acceptable CSRF defense per BCP §6.1.3.3 when `Strict` is not used.
- **Strict opt-in:** Set **`session.sameSite: 'Strict'`** when your deployment is fully same-site and does not rely on cross-site inbound navigation after login. This aligns with the BCP SHOULD without changing CSRF requirements.

```typescript
session: {
  ttl: "7d",
  sameSite: "Strict",
},
```

**Login binding cookies always use `SameSite=Lax`** — they must be sent on the cross-site top-level GET from the OIDC provider to `/auth/callback/...`. Only the long-lived session cookie honors `session.sameSite`.

Auth routes emit security headers via `SECURITY_HEADERS` (frame denial, nosniff, etc.). Cross-origin API calls from the SPA require correct CORS **and** CSRF headers on mutating verbs.

See [sessions-and-csrf.md](./sessions-and-csrf.md).

### Shared-host and subdomain platforms

`SameSite` alone is insufficient when your BFF cohabits a registrable domain with untrusted apps (e.g. `*.vercel.app`, `*.herokuapp.com`, multi-tenant PaaS subdomains). The **`__Host-` prefix** (no `Domain` attribute, `Path=/`, `Secure`) is the recommended mitigation — cookies are not shared across sibling subdomains. Prefer a dedicated hostname for production auth rather than default shared-host URLs.

See [deployment.md](./deployment.md#urls-and-same-site).

---

## Resolver hooks

| Hook | Deny behavior |
|---|---|
| `resolveIdentity` | `{ status: 'denied' }` → login error redirect, no session |
| `resolveAuthorization` | `{ status: 'revoked' }` → session deleted, anonymous |

Keep resolver logic deterministic and within configured timeouts. Slow resolvers block request authentication and return **503** `authentication_unavailable` when the store is unreachable.

---

## Audit events

When `auditWriter` is configured, the runtime emits:

| Event | When |
|---|---|
| `auth.login.started` | Redirect to IdP |
| `auth.login.succeeded` | Session created after callback |
| `auth.login.failed` / `cancelled` / `denied` | Callback errors |
| `auth.logout` | Local session cleared |
| `auth.session.replaced` | Session cap eviction |

Metadata is passed through `sanitizeAuditMetadata()` — never log raw cookies or CSRF tokens.

---

## Plumbus access policies

Session auth populates the same **`ctx.auth`** shape as JWT/OIDC adapters:

- `userId`, `roles`, `scopes`, `tenantId`, `provider`, `providerId`, `authenticatedAt`

Capability **`access`** policies remain authoritative. Frontend route guards (including `@plumbus/ui` generated helpers) are UX only.

---

## Secrets management

| Secret | Purpose |
|---|---|
| OIDC client secrets | Per-provider `{ env: '...' }` |
| Storage protection keys | HMAC + AEAD for store payloads |
| (Optional) separate DB encryption | `PLUMBUS_ENCRYPTION_KEY` for entity fields — orthogonal to auth stores |

Rotate storage protection keys with a migration plan. **`decryptOnlyKeys` retains envelope decryption for sealed payloads** (principal envelopes, login transactions) but **does not preserve live sessions:** session lookup HMACs (`session-id-hmac`, `user-lookup-hmac`, `csrf-hmac`) are computed only from `activeKey`, so changing the active key makes existing sessions unfindable even when the previous key remains listed for decrypt-only use. Plan for a forced global re-login on rotation, or accept that tradeoff explicitly.

---

## IdP lifecycle and machine clients

- **IdP disablement / back-channel logout / SCIM** are out of scope for MVP. Local logout always clears the Plumbus session (`POST /auth/logout`); federated single logout requires provider-specific integration hooks when you need it.
- **Stale bearer credentials:** When a request includes a non-empty `Authorization` header, the composite authenticator validates bearer first and returns **`401 invalid_authorization`** on failure — it does **not** fall back to the session cookie. Browsers mixing bearer headers with session cookies must send a valid bearer token or omit the header entirely.

---

## Related docs

- [Plumbus security model](../security/security-model.md)
- [deployment.md](./deployment.md)
