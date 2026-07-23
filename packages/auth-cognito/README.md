# @plumbus/auth-cognito

Amazon Cognito provider integration for [`@plumbus/auth`](../auth/). Supplies the **`cognito()`** integration object: hosted UI `identity_provider` allowlist and logout URL construction (`client_id` + `logout_uri`).

**Confidential client only** — Cognito app clients must have a client secret; public/SPA clients are not supported by `@plumbus/auth`.

Peer: `@plumbus/auth` at **`0.1.x`**.

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

## Documentation

- **Human docs:** [`docs/auth/cognito.md`](../../docs/auth/cognito.md)
- **Agent instructions:** [`instructions/`](./instructions/)

## The Plumbus ecosystem

`@plumbus/auth-cognito` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Auth docs** — [docs/auth/](../../docs/auth/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
