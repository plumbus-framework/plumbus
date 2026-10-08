# @plumbus/auth-cognito

> **Amazon Cognito for [Plumbus](https://github.com/plumbus-framework/plumbus) apps.** Put Cognito's hosted login behind [`@plumbus/auth`](../auth/) with one `cognito()` integration, or keep your own passwordless sign-in (magic links, passkeys) and sign each person into their Cognito user from the server — with idempotent pool administration and an in-process fake Cognito for tests.

[![npm](https://img.shields.io/npm/v/@plumbus/auth-cognito.svg)](https://www.npmjs.com/package/@plumbus/auth-cognito)
[![license](https://img.shields.io/npm/l/@plumbus/auth-cognito.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/auth 0.2.x](https://img.shields.io/badge/peer-%40plumbus%2Fauth%200.2.x-blue)](https://www.npmjs.com/package/@plumbus/auth)
[![Amazon Cognito](https://img.shields.io/badge/Amazon-Cognito-ff9900)](https://aws.amazon.com/cognito/)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. Browser sign-in goes through [`@plumbus/auth`](../auth/), its OIDC relying-party runtime: hosted login redirect, opaque server sessions, CSRF.

`@plumbus/auth-cognito` is the **Amazon Cognito package** for that stack, in two shapes:

- **Hosted login** (root export) — the `cognito()` integration for `@plumbus/auth`: an allowlist for the hosted UI's `identity_provider`, client-auth method selection, and Cognito's logout URL (`client_id` + `logout_uri`). It adds Cognito-specific parameters and never alters OIDC protocol validation.
- **Server-attested sign-in** (`./server` + `./triggers`) — the app authenticates people itself and uses Cognito as the user directory and token issuer. After the app's own check, the server signs the person into their Cognito user through custom auth, answered with an HMAC attestation that only the server and the pool's trigger Lambda can produce. No hosted UI.

## Why?

Cognito's hosted login has no magic links, and its custom-auth API is server-to-server. Apps that already sign people in with a mailed link or a passkey, but want Cognito as the directory of record, usually end up writing:

- a Define/Create/Verify trigger trio for custom auth, and a shared secret to gate it
- pool and app-client setup that must not drift into self sign-up or emailed reset codes
- ID-token verification against each pool's JWKS
- a stand-in for Cognito so tests do not need an AWS account

This package ships those pieces, tested against each other. The hosted-login half stays a thin integration on `@plumbus/auth`, so apps that only use Cognito's login page get nothing extra in their code path.

## What you get

| Surface | What it does |
|---|---|
| **`cognito()`** (root) | `@plumbus/auth` provider integration: hosted-UI `identity_provider` allowlist and default, `lang` hint, client-auth method (`client_secret_basic` / `client_secret_post`), provider logout URL, and registration warnings for non-Cognito issuers. |
| **`createCognitoPoolUsers()`** (`./server`) | Per pool: `ensureUser` (admin-created, no Cognito message, email verified, `CONFIRMED`), `signIn` (custom auth + attestation → verified ID-token identity, refresh token revoked), `getUser`, `setUserEnabled`, `updateEmail`. |
| **`createCognitoPoolAdministration()`** (`./server`) | Idempotent `ensureAttestedUserPool` (admin-only sign-up, `admin_only` recovery, triggers, deletion protection, ownership tags, secretless custom-auth client), ownership-checked `deleteUserPool`, `readMfaPolicy`. |
| **`createCognitoPoolDirectory()`** (`./server`) | A hosted-login pool's users without signing anyone in: `inviteUser` (optionally with no mail yet), `resendInvitation`, `getUser`, `listUsers`, `setUserEnabled`, `deleteUser`, `updateEmail`. |
| **`createCognitoIdTokenVerifier()`** (`./server`) | Checks a pool's ID tokens: JWKS signature, issuer, audience, `token_use`. |
| **`CognitoServerError`** (`./server`) | One error type with a stable `reason` (`user-disabled`, `challenge-refused`, `provider-unavailable`, …). |
| **`createAttestedSignInTrigger()`** (`./triggers`) | One dependency-free Lambda handler for all three custom-auth triggers. Keys can be a list or an async loader. |
| **`startFakeCognito()`** (`./testing`) | An in-process Cognito for the real AWS SDK (endpoint override): pools, clients, users, custom auth with the real trigger, per-pool JWKS and OIDC discovery, a minimal hosted login, fault injection, and the invitation mails it would have sent. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Browser login with any OIDC provider (Okta, Entra ID, Auth0, …) | [`@plumbus/auth`](../auth/) alone |
| Cognito's hosted login page, with identity-provider pinning and Cognito logout | `@plumbus/auth` + **`cognito()`** from this package |
| Your own passwordless sign-in, with Cognito as the user directory and token issuer | **`@plumbus/auth-cognito/server`** + **`/triggers`** |
| Stateless bearer JWTs from Cognito, verified on every API request | `createOidcAdapter()` / `createJwtAdapter()` in `@plumbus/core` |

## Status

Optional add-on for `@plumbus/auth` (version-locked **`0.2.x`**; peer `@plumbus/auth` **`0.2.x`**). The server-attested subpaths (`./server`, `./triggers`, `./testing`) are available from **0.2.2**; they depend on the AWS SDK and `jose`, which the root `cognito()` export and `./triggers` never load. Agent wiring **v18** (`@plumbus/core` **≥ 0.7.7**) links the package's `attested-sign-in.md` recipe.

Not included: a general Cognito emulator (the fake covers the actions this package uses), identity pools / federated AWS credentials, and hosted login for public (secretless) app clients.

## Install

```bash
pnpm add @plumbus/auth @plumbus/auth-cognito
```

Peer (copy literally): `@plumbus/auth` `0.2.x`. See `packages/plumbus-core/instructions/peer-dependencies.md`.

If agent wiring predates the Cognito recipes, refresh:

```bash
plumbus init --patch --agent all
plumbus doctor
```

## Quick start

### Hosted login

Create an app client **with a client secret**, the authorization code grant and PKCE; register `{externalBaseUrl}/auth/callback/cognito` as its callback URL.

```typescript
import { createAuthRuntime } from '@plumbus/auth';
import { cognito } from '@plumbus/auth-cognito';

const authenticationRuntime = createAuthRuntime({
  // …applicationId, URLs, stores, resolvers
  providers: {
    cognito: {
      type: 'oidc',
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX',
      clientId: process.env.COGNITO_CLIENT_ID!,
      clientSecret: { env: 'COGNITO_CLIENT_SECRET' },
      scopes: ['openid', 'email'],
      integration: cognito({
        hostedLogin: { allowedIdentityProviders: ['Google', 'COGNITO'] },
        logout: { domain: 'https://myapp.auth.us-east-1.amazoncognito.com' },
      }),
      providerLogout: { returnTo: '/' },
    },
  },
  defaultProvider: 'cognito',
});
```

### Server-attested sign-in

**1. Deploy the trigger Lambda** — one function for all three custom-auth triggers, with a resource policy that lets `cognito-idp.amazonaws.com` invoke it:

```typescript
import { createAttestedSignInTrigger, parseAttestationKeys } from '@plumbus/auth-cognito/triggers';

export const handler = createAttestedSignInTrigger({
  keys: parseAttestationKeys(process.env.COGNITO_ATTESTATION_KEYS), // "k2:secret,k1:old-secret"
});
```

**2. Provision each pool — once, from one place** (a provisioning step, a one-off job, or an operator command). `ensureAttestedUserPool` attaches the Lambda as the pool's `DefineAuthChallenge`, `CreateAuthChallenge` and `VerifyAuthChallengeResponse` triggers:

```typescript
import { createCognitoPoolAdministration } from '@plumbus/auth-cognito/server';

const admin = createCognitoPoolAdministration({ region: 'eu-west-1' });
const pool = await admin.ensureAttestedUserPool({
  name: 'myapp-tenant-a',
  tags: { 'myapp:tenant': 'tenant-a' },
  triggerArn: process.env.COGNITO_TRIGGER_ARN!,
});
// Store pool.userPoolId and pool.clientId with the tenant.
```

**3. Sign in, after your app has authenticated the person:**

```typescript
import { createCognitoPoolUsers, parseAttestationKeys } from '@plumbus/auth-cognito/server';

const users = createCognitoPoolUsers({
  region: 'eu-west-1',
  userPoolId: pool.userPoolId,
  clientId: pool.clientId,
  attestationKeys: parseAttestationKeys(process.env.COGNITO_ATTESTATION_KEYS),
});

await users.ensureUser({ username: accountId, email });
const identity = await users.signIn({ username: accountId });
// identity.issuer + identity.subject (the immutable `sub`) key your identity link.
```

**AWS credentials:** the default AWS credential chain (environment keys, shared config, IRSA / EKS Pod Identity, instance role), or pass `credentials` or a preconfigured `client`. The server needs HTTPS to `cognito-idp.<region>.amazonaws.com` for both the API and the pool's JWKS.

## How a server-attested sign-in flows

```
app has authenticated the person (magic link, passkey, …)
       │
       ▼
 users.signIn({ username })
       │
       ├─→ AdminInitiateAuth (CUSTOM_AUTH)
       │        └─ Create trigger issues a random nonce
       │
       ├─→ AdminRespondToAuthChallenge
       │        answer = HMAC-SHA256(pool id, username, nonce)   ← keyring shared with the Lambda
       │        └─ Verify trigger checks it; Define allows exactly one challenge, then issues tokens
       │
       ├─→ ID token verified against the pool's JWKS          ← issuer, audience, token_use, username
       ├─→ refresh token revoked                              ← the app keeps no Cognito tokens
       ▼
 AttestedCognitoIdentity { issuer, subject, username, email, emailVerified, authTime, claims }
```

An attestation for one pool, user or nonce is useless for any other, so one trigger and one keyring can serve many pools.

## Public API

| Export | Purpose |
|---|---|
| `cognito(options?)`, `CognitoIntegrationOptions` | Hosted-login integration for an `@plumbus/auth` OIDC provider entry. |
| `createCognitoPoolUsers(options)` (`./server`) | Users of one attested pool: `ensureUser`, `signIn`, `getUser`, `setUserEnabled`, `updateEmail`. |
| `createCognitoPoolAdministration(options)` (`./server`) | `ensureAttestedUserPool`, `deleteUserPool`, `readMfaPolicy`, `issuerFor`. |
| `createCognitoPoolDirectory(options)` (`./server`) | Users of any pool without sign-in: `inviteUser`, `resendInvitation`, `getUser`, `listUsers`, `setUserEnabled`, `deleteUser`, `updateEmail`. |
| `createCognitoIdTokenVerifier({ issuer, clientId })` (`./server`) | ID-token verification against a pool's JWKS. |
| `cognitoUserPoolIssuer`, `regionOfUserPool`, `assertUserPoolId` (`./server`) | Pool id and issuer helpers. |
| `parseAttestationKeys` (`./server`, `./triggers`), `validateAttestationKeys` (`./server`) | Keyring from `id:secret[,id:secret…]`; the first key signs, every key verifies. |
| `CognitoServerError`, `CognitoServerErrorReason`, `toCognitoServerError` (`./server`) | The error type and its stable reasons. |
| `createAttestedSignInTrigger({ keys })` (`./triggers`) | The Lambda handler for all three triggers. |
| `defineAttestedChallenge`, `createAttestedChallenge`, `verifyAttestedChallenge`, `CognitoTriggerSource` (`./triggers`) | The three trigger steps, for apps that route triggers themselves. |
| `startFakeCognito(options?)` (`./testing`) | In-process fake: `clientConfig`, `issuerFor`, `failAction` / `clearFailures`, `deliveries`, `setHostedLoginUser`, `markFederated`, `close`. |

## Key gotchas

- **`signIn` mints Cognito tokens for any username the keyring holder names.** Call it only after the app has authenticated the person, and resolve the account first — never pass request input straight into `username`.
- **Provision pools from one place.** `ensureAttestedUserPool` is idempotent but not safe to run concurrently for one name: Cognito pool names are not unique, so two simultaneous calls can create two pools. Never call it from start-up code every replica runs (Kubernetes pods, autoscaled instances). `ensureUser` and `signIn` are safe on every replica.
- **The server and the Lambda need the same keyring.** Secrets are at least 32 characters. Rotate by adding the new key second on both, deploying, moving it first, deploying, then dropping the old key.
- **The Lambda needs a resource policy** allowing `cognito-idp.amazonaws.com` to invoke it for the pools' ARNs; without it Cognito cannot run the triggers and every sign-in fails.
- **Unknown users look like refused challenges.** The app client hides user existence, so `signIn` for a missing user reports `challenge-refused`, not `user-not-found`. Map `provider-unavailable` to a retryable response and fail closed on every other reason.
- **Hosted login is confidential-client only.** `@plumbus/auth` requires a client secret; Cognito's console often defaults to none.
- **`logout.domain` must be an HTTPS origin with an empty path** — `cognito()` throws otherwise. No provider logout URL is built for a non-HTTPS origin.
- **Cognito ID tokens carry no `amr` or `acr`.** To require MFA on a hosted-login pool, read the pool's policy with `readMfaPolicy`; federated users skip the pool's MFA.
- **`./server` and `./testing` are Node-only.** Never import them into browser code, and never serve `./testing` in production.
- **cognitox has no custom auth.** `AdminInitiateAuth` with `CUSTOM_AUTH` answers `NotImplementedException` there; test server-attested sign-in against `startFakeCognito()`.

## Documentation

- **Concepts and reference** (in the monorepo): [`docs/auth/`](../../docs/auth/)
  - [`cognito.md`](../../docs/auth/cognito.md) — pool setup, hosted login, server-attested sign-in, pool settings, IAM, errors, testing without AWS
  - [`deployment.md`](../../docs/auth/deployment.md) — package versions, secrets, multiple instances
  - [`testing.md`](../../docs/auth/testing.md) — fake OIDC provider and `startFakeCognito()`
- **Live smoke** (monorepo): [`examples/auth-cognito-smoke`](../../examples/auth-cognito-smoke) — hosted login against cognitox, server-attested sign-in against the fake
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/auth-cognito/instructions/`):
  - [`instructions/README.md`](./instructions/README.md) — index and reading order
  - [`instructions/framework.md`](./instructions/framework.md) — package boundary, public exports, critical rules
  - [`instructions/configure-cognito.md`](./instructions/configure-cognito.md) — registering `cognito()` on a provider entry
  - [`instructions/hosted-login-options.md`](./instructions/hosted-login-options.md) — identity-provider allowlist and defaults
  - [`instructions/logout.md`](./instructions/logout.md) — Cognito logout URL builder
  - [`instructions/attested-sign-in.md`](./instructions/attested-sign-in.md) — `./server`, `./triggers`, pool administration, keys, errors
  - [`instructions/testing.md`](./instructions/testing.md) — integration tests and `startFakeCognito()`

## The Plumbus ecosystem

`@plumbus/auth-cognito` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/auth`](../auth/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Amazon Cognito custom authentication** — [docs.aws.amazon.com](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-challenge.html)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
