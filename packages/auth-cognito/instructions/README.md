# @plumbus/auth-cognito — Agent Instructions

Amazon Cognito for Plumbus apps. Read when the app's OIDC provider is a Cognito user pool with hosted UI, or when the app keeps its own passwordless sign-in (magic links, passkeys) and uses Cognito as the user directory.

| File | When to read |
|---|---|
| [framework.md](./framework.md) | Package boundary and critical rules. |
| [configure-cognito.md](./configure-cognito.md) | Register `cognito()` on a provider entry. |
| [hosted-login-options.md](./hosted-login-options.md) | Identity provider allowlist and defaults. |
| [logout.md](./logout.md) | Cognito logout URL builder. |
| [attested-sign-in.md](./attested-sign-in.md) | Server-attested sign-in: `./server`, `./triggers`, pool administration, keys, errors. |
| [testing.md](./testing.md) | Unit test patterns for integration options; `startFakeCognito()` for everything that talks to Cognito. |

Hosted login requires `@plumbus/auth` **`0.2.x`** installed; the server-attested entry points do not use it.

Package quickstart: [../README.md](../README.md).
