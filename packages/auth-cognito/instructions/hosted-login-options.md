# Cognito Hosted Login Options

Passed to `cognito({ hostedLogin: { ... } })`.

## allowedIdentityProviders

Required when pinning IdPs. Each entry becomes an allowed `identity_provider` query param on the authorize redirect.

```ts
hostedLogin: {
  allowedIdentityProviders: ["Google", "Facebook", "COGNITO"],
  defaultIdentityProvider: "Google",
  allowLangHint: true,
},
```

| Rule | Detail |
|---|---|
| Entries | Non-empty ASCII strings, max 128 bytes each |
| Uniqueness | Duplicates throw at construction |
| Default | `defaultIdentityProvider` must be in the allowlist when an allowlist is configured |
| No allowlist | `defaultIdentityProvider` is forwarded without IdP pinning — set `allowedIdentityProviders` to restrict choices |

## Hosted UI domain

Obtain the domain from **User pool → App integration → Domain** in the AWS console (managed login or classic hosted UI). Use that HTTPS origin for `logout.domain` — not the IdP issuer URL.

## COGNITO idp

Use the literal **`COGNITO`** entry for the built-in user pool username/password UI.

## allowLangHint

When `true`, a `lang` query param on `/auth/login/cognito?lang=…` is forwarded to Cognito when allowed.

## Critical rules

- **Do not pass arbitrary `identity_provider` values** — only allowlisted names reach Cognito.
- **Provider query params on login URL** are validated before redirect — unknown keys are rejected by `@plumbus/auth`.

Human docs: [docs/auth/cognito.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/cognito.md).
