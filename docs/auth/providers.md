# OIDC Providers

**Previous:** [configuration.md](./configuration.md) · **Next:** [sessions-and-csrf.md](./sessions-and-csrf.md)

Register IdPs under `providers` in `AuthRuntimeConfig`. Each entry is an **`OidcProviderRegistration`** with `type: 'oidc'`.

---

## Registration shape

```typescript
providers: {
  okta: {
    type: "oidc",
    issuer: "https://example.okta.com/oauth2/default",
    clientId: process.env.OKTA_CLIENT_ID!,
    clientSecret: { env: "OKTA_CLIENT_SECRET" },
    scopes: ["openid", "profile", "email"],
    discoverable: true,
    display: { label: "Sign in with Okta" },
    fetchUserInfo: false,
    providerLogout: { returnTo: "/logged-out" },
  },
},
defaultProvider: "okta",
```

| Field | Description |
|---|---|
| `issuer` | OIDC issuer URL — discovery document fetched at startup |
| `clientId` / `clientSecret` | RP credentials; secret via `{ env: 'VAR' }` or `{ literal: '...' }` |
| `scopes` | Requested scopes (must include `openid`) |
| `discoverable` | When `true`, listed on `GET /auth/providers` |
| `display.label` | Human label in provider picker UIs |
| `fetchUserInfo` | When `true`, call UserInfo endpoint after token exchange |
| `integration` | Optional `OidcProviderIntegration` — Cognito uses `@plumbus/auth-cognito` |
| `providerLogout.returnTo` | Relative path on `applicationBaseUrl` for RP-initiated logout |

---

## Discovery and availability

At `initialize()`, the runtime discovers each provider's metadata (`authorization_endpoint`, `token_endpoint`, `jwks_uri`, etc.). Failed discovery marks the provider **unavailable** — login attempts return **503** with `{ error: 'provider_unavailable' }`.

Discovery retries are cleared on `close()`.

---

## Login URLs

| Route | Behavior |
|---|---|
| `GET /auth/login?returnTo=/path` | Uses `defaultProvider` |
| `GET /auth/login/:provider?returnTo=/path` | Named provider |
| `GET /auth/providers` | JSON list of discoverable providers |

Provider-specific query parameters are validated through the optional **`integration`** hook before redirect.

---

## Provider integrations

Integrations customize authorization params, logout URL construction, and registration warnings — **without** bypassing OIDC protocol validation.

```typescript
import { cognito } from "@plumbus/auth-cognito";

providers: {
  cognito: {
    type: "oidc",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX",
    clientId: process.env.COGNITO_CLIENT_ID!,
    clientSecret: { env: "COGNITO_CLIENT_SECRET" },
    scopes: ["openid", "email"],
    integration: cognito({
      hostedLogin: { allowedIdentityProviders: ["Google"] },
    }),
    providerLogout: { returnTo: "/" },
  },
},
```

See [cognito.md](./cognito.md).

---

## Logout

`POST /auth/logout` clears the local session. When `providerLogout` is configured and the integration or discovery metadata supplies an end-session URL, the JSON response may include **`providerLogoutUrl`** for the browser to redirect the user to IdP logout. Cognito requires `integration.logout.domain` because its discovery document omits `end_session_endpoint`.

Integrations implement `buildProviderLogoutUrl()` — Cognito uses `client_id` + `logout_uri` without retaining ID tokens.

---

## Multi-provider UX

- Set **`defaultProvider`** for single-button login (`/auth/login`).
- Expose **`GET /auth/providers`** for a picker UI.
- Keep **`discoverable: false`** on internal or machine-only providers.

Each provider id is stored on the session as **`ctx.auth.providerId`** (core 0.6.8+).
