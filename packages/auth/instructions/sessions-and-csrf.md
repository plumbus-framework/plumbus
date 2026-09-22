# Sessions and CSRF

Browser contract for `@plumbus/auth` cookie sessions.

## Session probe

```ts
const res = await fetch("/auth/session", { credentials: "include" });
const body = await res.json();
// body.authenticated, body.user, body.csrfToken, body.expiresAt
```

## Mutating API calls

```ts
await fetch("/api/domain/my-action", {
  method: "POST",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  },
  body: JSON.stringify(input),
});
```

Required for `POST`, `PUT`, `PATCH`, `DELETE`. Safe methods skip CSRF.

## Login redirect

```ts
window.location.href = `/auth/login?returnTo=${encodeURIComponent("/dashboard")}`;
```

Or provider-specific: `/auth/login/okta?returnTo=...`

## Logout

```ts
await fetch("/auth/logout", {
  method: "POST",
  credentials: "include",
  headers: { "X-CSRF-Token": csrfToken },
});
```

If response includes `providerLogoutUrl`, redirect the browser for IdP sign-out.

## Cookie name

Default: **`__Host-plumbus_session`**. Requires HTTPS in production.

Optional **`session.sameSite: 'Strict'`** for same-site-only deployments (binding cookies remain `Lax`). See human docs [security.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/security.md).

## @plumbus/ui generated auth

`generateAuthModule()` emits **localStorage bearer** helpers. For `@plumbus/auth`:

- Do **not** use generated `login()` token storage for production browser auth.
- Replace with `/auth/session` + CSRF pattern above.
- Keep `credentials: 'include'` on generated API clients where applicable.

## Cross-origin SPA

When `applicationBaseUrl` differs from `externalBaseUrl`:

- Configure CORS with credentials
- Ensure CSRF + Origin checks pass
- Do not set `deployment.assumeSameSite: true` in production

## Critical rules

- **Assume XSS-free frontend.** Deploy CSP; XSS can read `/auth/session` CSRF tokens and make authenticated requests. HttpOnly protects the cookie, not the token JSON.
- **Never store `csrfToken` in localStorage** — keep in memory per tab session.
- **Never expose session cookie to JavaScript** — it is HttpOnly by design.
- **Regenerate CSRF after login** — fetch `/auth/session` again post-redirect.

Human docs: [docs/auth/sessions-and-csrf.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/sessions-and-csrf.md).
