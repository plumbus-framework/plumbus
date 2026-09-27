# @plumbus/auth-cognito — Framework

## Release family 0.2.0

This package requires an explicit upgrade from its previous minor line. Current Plumbus peers: `@plumbus/auth` `0.3.x`. Install the matching versions of all Plumbus packages the app uses; do not bypass peer checks with `--force` or `--legacy-peer-deps`. Historical feature floors below describe earlier releases, not compatibility with this new family. Read the core `instructions/upgrading-security-release.md` checklist and refresh agent wiring with `plumbus init --patch` (v16).


`@plumbus/auth-cognito` supplies a **`cognito()`** `OidcProviderIntegration` for `@plumbus/auth`. It customizes Cognito hosted UI authorize params, builds logout URLs from the hosted UI domain, and emits registration warnings — **without** altering OIDC protocol validation in `@plumbus/auth`.

**Peer:** `"@plumbus/auth": ">=0.3.0-beta.0 <0.4.0"` — copy literally from `packages/auth-cognito/package.json`.

## When to install

```bash
pnpm add @plumbus/auth-cognito
```

Only when using **Amazon Cognito** as the OIDC provider. Generic OIDC IdPs do not need this package.

## Public exports

```ts
import { cognito } from "@plumbus/auth-cognito";
// CognitoIntegrationOptions type inferred from cognito() parameter

// Server-attested sign-in (Node, AWS SDK) — see attested-sign-in.md
import {
  createCognitoPoolAdministration,
  createCognitoPoolDirectory, // a hosted-login pool's users: invite, resend, list, enable/disable, delete
  createCognitoPoolUsers,
  createCognitoIdTokenVerifier,
  cognitoUserPoolIssuer,
  parseAttestationKeys,
  CognitoServerError,
  CognitoServerErrorReason,
} from "@plumbus/auth-cognito/server";

// The pool's Lambda trigger (dependency-free)
import { createAttestedSignInTrigger } from "@plumbus/auth-cognito/triggers";

// Tests only
import { startFakeCognito } from "@plumbus/auth-cognito/testing";
```

## Critical rules

1. **Hosted login: still use `@plumbus/auth` for sessions and routes** — the root export is integration-only.
2. **Do not bypass allowlist validation** — `allowedIdentityProviders` is enforced at construction.
3. **Logout domain must be HTTPS** with empty path — see [logout.md](./logout.md).
4. **Cannot disable PKCE or ID token checks** — integration hooks only add Cognito-specific query params.
5. **Server-attested sign-in runs only after the app authenticated the person itself** — `signIn()` mints Cognito tokens for any username the keyring holder names. Never expose it to unauthenticated input; see [attested-sign-in.md](./attested-sign-in.md).
6. **Never import `./server` or `./testing` into browser code** — they pull in the AWS SDK; `./testing` must never serve production.

Human docs: [docs/auth/cognito.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/cognito.md).
