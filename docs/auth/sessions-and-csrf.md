# Sessions and CSRF

**Previous:** [providers.md](./providers.md) · **Next:** [cognito.md](./cognito.md)

`@plumbus/auth` uses **opaque server-side sessions** — the browser holds only a random cookie value; roles and scopes are resolved on each request.

---

## Session cookie

| Property | Value |
|---|---|
| Name | `__Host-plumbus_session` (configurable via `session.cookieName`) |
| Contents | Opaque random token — not a JWT |
| Flags | `HttpOnly`, `Secure` (production), `SameSite` from `session.sameSite` (default `Lax`), `Path=/` |
| Prefix | `__Host-` requires HTTPS and forbids `Domain` attribute |

Login **binding** cookies always use `SameSite=Lax` so they are sent on the OIDC provider callback navigation.

The store indexes sessions by **HMAC(cookie value)** so raw tokens never appear in PostgreSQL.

---

## Authentication flow per request

```
Cookie present?
    │
    ▼
Load session from store → verify not expired
    │
    ▼
resolveAuthorization(principal) → roles, scopes, tenantId
    │
    ▼
ctx.auth populated → evaluateAccess() on capabilities
```

If authorization returns **`revoked`**, the session is deleted and the client receives anonymous auth.

---

## CSRF model

Mutating HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`) require:

1. Valid session cookie
2. **`Origin`** (or equivalent) matching `applicationBaseUrl` when cross-site rules apply
3. **`X-CSRF-Token`** header matching the session's stored CSRF hash

Safe methods (`GET`, `HEAD`, `OPTIONS`) do not require CSRF.

Failure returns **403** `{ error: 'csrf_failed' }` from auth routes; capability routes return the structured **`csrf_failed`** error via `authenticationFailureToHttp()`.

---

## `/auth/session` contract

**Request:** `GET /auth/session` with `credentials: 'include'`

**Anonymous response:**

```json
{ "authenticated": false }
```

**Authenticated response:**

```json
{
  "authenticated": true,
  "user": {
    "userId": "usr_abc",
    "roles": ["user"],
    "scopes": [],
    "tenantId": "ten_xyz",
    "provider": "oidc",
    "providerId": "okta",
    "authenticatedAt": "2026-07-21T12:00:00.000Z"
  },
  "csrfToken": "<token>",
  "expiresAt": "2026-07-28T12:00:00.000Z"
}
```

SPAs should:

1. Call `/auth/session` on load
2. Cache `csrfToken` in memory (not localStorage)
3. Attach `X-CSRF-Token` to mutating API calls
4. Re-fetch after login redirect or `401`/`403 csrf_failed`

**XSS note:** The CSRF token is readable by same-origin JavaScript — HttpOnly protects the session cookie, not the token returned in JSON. An XSS vulnerability yields fully authenticated API access. Deploy a strong CSP and treat XSS prevention as mandatory; see [security.md](./security.md#frontend-xss-and-content-security-policy).

---

## Frontend fetch example

```typescript
const session = await fetch("/auth/session", { credentials: "include" }).then((r) => r.json());

await fetch("/api/users/me", {
  method: "POST",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": session.csrfToken,
  },
  body: JSON.stringify({ action: "update" }),
});
```

`@plumbus/chat-ui`'s `<ChatPanel />` already uses `credentials: 'include'` — pair it with session auth by ensuring the chat turn route accepts cookie sessions.

---

## Session caps

`session.maxSessionsPerUser` (default **5**) evicts oldest sessions when a user logs in on a new device. Eviction emits **`auth.session.replaced`** audit events.

---

## Logout

```typescript
await fetch("/auth/logout", {
  method: "POST",
  credentials: "include",
  headers: { "X-CSRF-Token": csrfToken },
});
```

Response may include **`providerLogoutUrl`** for federated sign-out.
