# @plumbus/auth-cognito

Amazon Cognito for Plumbus apps, in two shapes:

- **Hosted login** (root export) — the **`cognito()`** integration for [`@plumbus/auth`](../auth/): hosted UI `identity_provider` allowlist and logout URL construction (`client_id` + `logout_uri`). **Confidential client only** — Cognito app clients must have a client secret; public/SPA clients are not supported by `@plumbus/auth`.
- **Server-attested sign-in** (`@plumbus/auth-cognito/server` + `/triggers`) — the app keeps its own passwordless sign-in (magic links, passkeys) and signs the person into their Cognito user from the server through custom auth. Cognito stays the directory and token issuer; no hosted UI. Includes idempotent pool administration and an in-process fake Cognito for tests (`/testing`).

Peer: `@plumbus/auth` at **`0.2.x`**.

## Install

```bash
pnpm add @plumbus/auth @plumbus/auth-cognito
```

## Usage

```typescript
import { createAuthRuntime } from "@plumbus/auth";
import { cognito } from "@plumbus/auth-cognito";

const authenticationRuntime = createAuthRuntime({
  // …applicationId, URLs, stores, resolvers
  providers: {
    cognito: {
      type: "oidc",
      issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX",
      clientId: process.env.COGNITO_CLIENT_ID!,
      clientSecret: { env: "COGNITO_CLIENT_SECRET" },
      scopes: ["openid", "email"],
      integration: cognito({
        hostedLogin: { allowedIdentityProviders: ["Google", "COGNITO"] },
        logout: { domain: "https://myapp.auth.us-east-1.amazoncognito.com" },
      }),
      providerLogout: { returnTo: "/" },
    },
  },
  defaultProvider: "cognito",
});
```

## Server-attested sign-in

```typescript
import { createCognitoPoolUsers, parseAttestationKeys } from "@plumbus/auth-cognito/server";

const users = createCognitoPoolUsers({
  region: "eu-west-1",
  userPoolId,
  clientId,
  attestationKeys: parseAttestationKeys(process.env.COGNITO_ATTESTATION_KEYS),
});
await users.ensureUser({ username: accountId, email });
const identity = await users.signIn({ username: accountId }); // verified ID-token identity
```

The pool's trigger Lambda is `createAttestedSignInTrigger({ keys })` from `@plumbus/auth-cognito/triggers`. Tests use `startFakeCognito()` from `@plumbus/auth-cognito/testing`.

## Documentation

- **Human docs:** [`docs/auth/cognito.md`](../../docs/auth/cognito.md)
- **Agent instructions:** [`instructions/`](./instructions/)

## The Plumbus ecosystem

`@plumbus/auth-cognito` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Auth docs** — [docs/auth/](../../docs/auth/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
