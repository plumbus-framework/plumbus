# Configure Cognito Provider

## App client requirements

| Requirement | Detail |
|---|---|
| OAuth grant | Authorization code |
| PKCE | Enabled on app client |
| Client secret | **Required** — enable **Generate a client secret** in the Cognito console |

**Public / SPA app clients (no secret) are not supported.** `@plumbus/auth` requires `clientSecret` on every provider. Cognito often defaults to no secret — if you create a public client, config validation fails with no Cognito-specific hint.

## Recipe

```ts
import { createAuthRuntime } from "@plumbus/auth";
import { cognito } from "@plumbus/auth-cognito";

const authenticationRuntime = createAuthRuntime({
  // ...applicationId, URLs, stores, resolvers
  providers: {
    cognito: {
      type: "oidc",
      issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX",
      clientId: process.env.COGNITO_CLIENT_ID!,
      clientSecret: { env: "COGNITO_CLIENT_SECRET" },
      scopes: ["openid", "email", "profile"],
      discoverable: true,
      display: { label: "Sign in" },
      integration: cognito({
        hostedLogin: {
          allowedIdentityProviders: ["Google", "COGNITO"],
        },
        logout: {
          domain: "https://myapp.auth.us-east-1.amazoncognito.com",
        },
      }),
      providerLogout: { returnTo: "/" },
    },
  },
  defaultProvider: "cognito",

  resolveIdentity: async (identity) => {
    const groups = (identity.idTokenClaims["cognito:groups"] as string[] | undefined) ?? [];
    const userId = await upsertUser(identity.issuer, identity.subject, { groups });
    return { status: "admitted", userId };
  },

  resolveAuthorization: async (principal) => {
    const roles = await rolesForUser(principal.userId);
    return { status: "authorized", roles, scopes: [] };
  },
});
```

## AWS console URLs

| Setting | Value |
|---|---|
| Callback | `{externalBaseUrl}/auth/callback/cognito` |
| Sign-out | `{applicationBaseUrl}/` (match `providerLogout.returnTo`) |
| OAuth grant | Authorization code |
| PKCE | Required (enabled on app client) |
| Client secret | **Required** — Generate a client secret (confidential client only) |

## Identity and groups

- **Key users on `identity.subject` (Cognito `sub`)** — immutable per pool. Never key on `email` or `cognito:username` (mutable; account-takeover risk).
- **`cognito:groups` is in `idTokenClaims` at login only** — read it in `resolveIdentity`, persist to your user record. `resolveAuthorization` receives `SessionPrincipal` without claims; return roles from your store.

See human docs [cognito.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/cognito.md#cognito-groups--roles).

## Issuer format

```
https://cognito-idp.{region}.amazonaws.com/{userPoolId}
```

`cognito().validateRegistration()` warns when issuer does not match this pattern.

## Do not

- Point issuer at the hosted UI domain — use the **IdP issuer** URL above.
- Omit `openid` from scopes.
- Create a public app client without a client secret.
- Key users on email or `cognito:username`.
- Read `cognito:groups` inside `resolveAuthorization` — it is not on the session principal.

See [hosted-login-options.md](./hosted-login-options.md) and [logout.md](./logout.md).
