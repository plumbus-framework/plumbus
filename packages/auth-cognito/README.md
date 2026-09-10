# @plumbus/auth-cognito

## Release family 0.2.0

This package requires an explicit upgrade from its previous minor line. Current Plumbus peers: `@plumbus/auth` `0.2.x`. Install the matching versions of all Plumbus packages the app uses; do not bypass peer checks with `--force` or `--legacy-peer-deps`. Historical feature floors below describe earlier releases, not compatibility with this new family. Packages stage under `next`; read the core `instructions/upgrading-security-release.md` checklist and refresh agent wiring with `plumbus init --patch` (v16).


Amazon Cognito provider integration for [`@plumbus/auth`](../auth/). Supplies the **`cognito()`** integration object: hosted UI `identity_provider` allowlist and logout URL construction (`client_id` + `logout_uri`).

**Confidential client only** — Cognito app clients must have a client secret; public/SPA clients are not supported by `@plumbus/auth`.

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

## Documentation

- **Human docs:** [`docs/auth/cognito.md`](../../docs/auth/cognito.md)
- **Agent instructions:** [`instructions/`](./instructions/)

## The Plumbus ecosystem

`@plumbus/auth-cognito` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Auth docs** — [docs/auth/](../../docs/auth/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
