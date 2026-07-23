# @plumbus/auth-cognito — Framework

`@plumbus/auth-cognito` supplies a **`cognito()`** `OidcProviderIntegration` for `@plumbus/auth`. It customizes Cognito hosted UI authorize params, builds logout URLs from the hosted UI domain, and emits registration warnings — **without** altering OIDC protocol validation in `@plumbus/auth`.

**Peer:** `"@plumbus/auth": "0.1.x"` — copy literally from `packages/auth-cognito/package.json`.

## When to install

```bash
pnpm add @plumbus/auth-cognito
```

Only when using **Amazon Cognito** as the OIDC provider. Generic OIDC IdPs do not need this package.

## Public exports

```ts
import { cognito } from "@plumbus/auth-cognito";
// CognitoIntegrationOptions type inferred from cognito() parameter
```

## Critical rules

1. **Still use `@plumbus/auth` for sessions and routes** — this package is integration-only.
2. **Do not bypass allowlist validation** — `allowedIdentityProviders` is enforced at construction.
3. **Logout domain must be HTTPS** with empty path — see [logout.md](./logout.md).
4. **Cannot disable PKCE or ID token checks** — integration hooks only add Cognito-specific query params.

Human docs: [docs/auth/cognito.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/cognito.md).
