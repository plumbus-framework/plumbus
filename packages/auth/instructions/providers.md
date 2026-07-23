# OIDC Providers

Register providers on `AuthRuntimeConfig.providers`. Keys are **provider ids** (URL segment in `/auth/login/:provider`).

## Recipe

```ts
providers: {
  okta: {
    type: "oidc",
    issuer: "https://example.okta.com/oauth2/default",
    clientId: process.env.OKTA_CLIENT_ID!,
    clientSecret: { env: "OKTA_CLIENT_SECRET" },
    scopes: ["openid", "profile", "email"],
    discoverable: true,
    display: { label: "Okta" },
    fetchUserInfo: false,
    providerLogout: { returnTo: "/goodbye" },
  },
},
defaultProvider: "okta",
```

## Client secret sources

```ts
clientSecret: { env: "OKTA_CLIENT_SECRET" }
clientSecret: { literal: "dev-only-secret" } // tests only
```

## Cognito

```ts
import { cognito } from "@plumbus/auth-cognito";

integration: cognito({ hostedLogin: { allowedIdentityProviders: ["Google"] } }),
```

Read `node_modules/@plumbus/auth-cognito/instructions/configure-cognito.md`.

## Callback URL (IdP console)

Register:

```
{externalBaseUrl}/auth/callback/{providerId}
```

Example: `https://api.example.com/auth/callback/okta`

## Provider integrations

Optional `OidcProviderIntegration` hooks:

- `authorizationParams(input)` — extra authorize query params
- `buildProviderLogoutUrl(input)` — federated logout URL (required for Cognito)
- `validateRegistration(reg)` — startup warnings
- `selectClientAuthMethod(advertised)` — reserved; not invoked by `@plumbus/auth` discovery today (runtime uses `client_secret_post`)

Integrations **must not** disable PKCE, state, or ID token validation.

## Critical rules

- **`scopes` must include `openid`.**
- **`issuer` must match ID token `iss`.**
- Set `discoverable: false` for providers that should not appear on `GET /auth/providers`.
- **`providerLogout.returnTo` is a relative path** on `applicationBaseUrl`.

Human docs: [docs/auth/providers.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/providers.md).
