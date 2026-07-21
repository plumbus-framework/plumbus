# Cognito Logout

Cognito federated logout uses the hosted UI **`/logout`** endpoint with **`client_id`** and **`logout_uri`** — no ID token hint is retained server-side.

`logout.domain` must be the Cognito **hosted UI domain** (from **App integration → Domain**). Cognito discovery does not advertise `end_session_endpoint`; without this domain, federated logout is skipped.

## Configuration

```ts
integration: cognito({
  logout: {
    domain: "https://myapp.auth.us-east-1.amazoncognito.com",
  },
}),
providerLogout: { returnTo: "/signed-out" },
```

`logout_uri` = `{applicationBaseUrl}{returnTo}` (e.g. `https://app.example.com/signed-out`).

## Runtime behavior

1. Client calls `POST /auth/logout` with CSRF (clears local session).
2. Response may include **`providerLogoutUrl`**.
3. Browser navigates to Cognito logout URL to clear IdP session.

## Domain validation

`logout.domain` must:

- Use `https:` protocol
- Have pathname `/` only
- Omit query, hash, username, password

Invalid domains throw when `cognito()` is constructed.

## Critical rules

- **Register sign-out URL in Cognito app client** — must match `logout_uri`.
- **Set `logout.domain` when using `providerLogout`** — omitting it silently skips federated logout; startup warns.
- **Do not store ID tokens for logout** — Cognito integration deliberately avoids token retention.

Human docs: [docs/auth/cognito.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/cognito.md).
