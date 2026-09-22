# Amazon Cognito

**Previous:** [sessions-and-csrf.md](./sessions-and-csrf.md) · **Next:** [security.md](./security.md)

Use **`@plumbus/auth-cognito`** when your OIDC provider is an Amazon Cognito user pool. The package supplies a **`cognito()`** integration object — it does not replace `@plumbus/auth`.

---

## Install

```bash
pnpm add @plumbus/auth @plumbus/auth-cognito
```

Peer: `@plumbus/auth` at **`0.1.x`**.

---

## User pool setup checklist

1. Create a Cognito user pool with a hosted UI domain.
2. Create an app client with **authorization code grant**, **PKCE**, and **Generate a client secret** enabled.
   - **Public / SPA app clients (no client secret) are not supported.** `@plumbus/auth` requires `clientSecret` on every provider — this integration is **confidential-client only**. Cognito's console often defaults to no secret; if you skip it, config validation fails before login with no Cognito-specific error.
3. Register callback URL: `{externalBaseUrl}/auth/callback/cognito`
4. Register sign-out URL: `{applicationBaseUrl}{providerLogout.returnTo}`
5. Copy **issuer** (`https://cognito-idp.{region}.amazonaws.com/{poolId}`), **client id**, and **client secret**.

---

## Registration

```typescript
import { cognito } from "@plumbus/auth-cognito";

providers: {
  cognito: {
    type: "oidc",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf",
    clientId: process.env.COGNITO_CLIENT_ID!,
    clientSecret: { env: "COGNITO_CLIENT_SECRET" },
    scopes: ["openid", "email", "profile"],
    discoverable: true,
    display: { label: "Sign in" },
    integration: cognito({
      hostedLogin: {
        allowedIdentityProviders: ["Google", "COGNITO"],
        defaultIdentityProvider: "Google",
      },
      logout: {
        domain: "https://myapp.auth.us-east-1.amazoncognito.com",
      },
    }),
    providerLogout: { returnTo: "/" },
  },
},
defaultProvider: "cognito",
```

---

## Hosted UI domain

Cognito exposes a **hosted UI domain** for authorize and logout — separate from the IdP issuer URL.

1. In the AWS console: **User pool → App integration → Domain**.
2. Copy the domain (managed login or classic hosted UI), e.g. `https://myapp.auth.us-east-1.amazoncognito.com`.
3. Set `integration.logout.domain` to that origin (HTTPS, path `/` only).

Register this domain's **`/logout`** sign-out URL in the app client (**Allowed sign-out URLs**).

---

## Hosted UI options

The integration allowlists **`identity_provider`** query params sent to Cognito's authorize endpoint:

| Option | Description |
|---|---|
| `allowedIdentityProviders` | Non-empty allowlist of IdP names (e.g. `Google`, `Facebook`, `COGNITO`) |
| `defaultIdentityProvider` | Must appear in the allowlist when set; when no allowlist is configured, the default is applied without IdP pinning |
| `allowLangHint` | When `true`, pass through `lang` query param |

Unknown or duplicate allowlist entries throw at integration construction time.

---

## Identity: always key on `sub`

Map users by **`identity.subject`** — Cognito's immutable per-pool UUID (`sub` claim). **Never** key on `email` or `cognito:username`; both are mutable and reassignable in Cognito, and using them as primary keys enables account takeover.

```typescript
resolveIdentity: async (identity) => {
  const user = await findUserBySubject(identity.issuer, identity.subject);
  return user ? { status: "admitted", userId: user.id } : { status: "denied" };
},
```

The runtime validates the ID token and passes `subject` from `claims.sub` — not from the access token.

---

## Cognito groups → roles

Cognito group membership arrives in the ID token as **`cognito:groups`**. This claim is available on **`VerifiedExternalIdentity.idTokenClaims` in `resolveIdentity`** (at login). It is **not** on `SessionPrincipal` — **`resolveAuthorization` does not receive ID token claims**, only `userId`, `issuer`, `subject`, `acr`, and `amr`.

Correct pattern:

1. **At login (`resolveIdentity`)** — read `cognito:groups`, persist to your user record.
2. **Per request (`resolveAuthorization`)** — load roles from your store (derived from stored groups).

```typescript
resolveIdentity: async (identity) => {
  const groups = (identity.idTokenClaims["cognito:groups"] as string[] | undefined) ?? [];
  const userId = await upsertUser(identity.issuer, identity.subject, { groups });
  return { status: "admitted", userId };
},

resolveAuthorization: async (principal) => {
  const roles = await rolesForUser(principal.userId); // from your DB, not idTokenClaims
  return { status: "authorized", roles, scopes: [] };
},
```

If group membership changes in Cognito, existing sessions keep roles from your store until the user logs in again (or you implement your own refresh). Re-run `resolveIdentity` on each login to capture updated groups.

---

## Token endpoint authentication

`@plumbus/auth` uses **`client_secret_post`** for confidential OIDC clients at the token endpoint. Cognito's discovery document does **not** advertise `token_endpoint_auth_methods_supported`; POST is the supported method for app clients with a secret.

The optional `selectClientAuthMethod` integration hook is reserved for future runtime use and is **not** invoked during discovery today.

---

## Logout

Cognito's discovery document does **not** include `end_session_endpoint`. Federated logout uses the hosted UI **`/logout`** endpoint with **`client_id`** + **`logout_uri`** (no ID token hint retained server-side).

Configure:

- `integration.logout.domain` — **required** for federated logout; hosted UI domain (`https://…amazoncognito.com`, path `/` only)
- `providerLogout.returnTo` — relative path combined with `applicationBaseUrl`

If `providerLogout` is set without `logout.domain`, startup emits an advisory warning and `POST /auth/logout` will not return `providerLogoutUrl`.

See [`packages/auth-cognito/instructions/logout.md`](../../packages/auth-cognito/instructions/logout.md).

---

## Validation warnings

`cognito()` runs **`validateRegistration()`** at startup and warns when the issuer URL does not match the expected Cognito IdP pattern. Warnings do not block discovery.

---

## Agent instructions

Cognito-specific recipes: [`packages/auth-cognito/instructions/`](../../packages/auth-cognito/instructions/).
