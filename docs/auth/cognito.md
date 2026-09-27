# Amazon Cognito

**Previous:** [sessions-and-csrf.md](./sessions-and-csrf.md) · **Next:** [security.md](./security.md)

Use **`@plumbus/auth-cognito`** when your identity provider is an Amazon Cognito user pool. It covers two shapes:

- **Hosted login** — Cognito's login page through the `@plumbus/auth` OIDC runtime. The package supplies a **`cognito()`** integration object; it does not replace `@plumbus/auth`.
- **Server-attested sign-in** — the app keeps its own passwordless sign-in (magic links, passkeys) and signs the person into their Cognito user from the server. Cognito stays the user directory and token issuer, with no hosted UI. See [Server-attested sign-in](#server-attested-sign-in-passwordless-apps).

---

## Install

```bash
pnpm add @plumbus/auth @plumbus/auth-cognito
```

Peer: `@plumbus/auth` at **`0.2.x`** (only the root export and hosted login use it).

---

## User pool setup checklist

1. Create a Cognito user pool with a hosted UI domain.
2. Create an app client with **authorization code grant**, **PKCE**, and **Generate a client secret** enabled.
   - **Public / SPA app clients (no client secret) are not supported.** `@plumbus/auth` requires `clientSecret` on every provider — this integration is **confidential-client only**. Cognito's console often defaults to no secret; if you skip it, config validation fails before login with no Cognito-specific error.
3. Register callback URL: `{externalBaseUrl}/auth/callback/cognito`
4. Register sign-out URL: `{applicationBaseUrl}{providerLogout.returnTo}`
5. Copy **issuer** (`https://cognito-idp.{region}.amazonaws.com/{poolId}`), **client id**, and **client secret**.

---

## Registration

```typescript
import { cognito } from "@plumbus/auth-cognito";

providers: {
  cognito: {
    type: "oidc",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf",
    clientId: process.env.COGNITO_CLIENT_ID!,
    clientSecret: { env: "COGNITO_CLIENT_SECRET" },
    scopes: ["openid", "email", "profile"],
    discoverable: true,
    display: { label: "Sign in" },
    integration: cognito({
      hostedLogin: {
        allowedIdentityProviders: ["Google", "COGNITO"],
        defaultIdentityProvider: "Google",
      },
      logout: {
        domain: "https://myapp.auth.us-east-1.amazoncognito.com",
      },
    }),
    providerLogout: { returnTo: "/" },
  },
},
defaultProvider: "cognito",
```

---

## Hosted UI domain

Cognito exposes a **hosted UI domain** for authorize and logout — separate from the IdP issuer URL.

1. In the AWS console: **User pool → App integration → Domain**.
2. Copy the domain (managed login or classic hosted UI), e.g. `https://myapp.auth.us-east-1.amazoncognito.com`.
3. Set `integration.logout.domain` to that origin (HTTPS, path `/` only).

Register this domain's **`/logout`** sign-out URL in the app client (**Allowed sign-out URLs**).

---

## Hosted UI options

The integration allowlists **`identity_provider`** query params sent to Cognito's authorize endpoint:

| Option | Description |
|---|---|
| `allowedIdentityProviders` | Non-empty allowlist of IdP names (e.g. `Google`, `Facebook`, `COGNITO`) |
| `defaultIdentityProvider` | Must appear in the allowlist when set; when no allowlist is configured, the default is applied without IdP pinning |
| `allowLangHint` | When `true`, pass through `lang` query param |

Unknown or duplicate allowlist entries throw at integration construction time.

---

## Identity: always key on `sub`

Map users by **`identity.subject`** — Cognito's immutable per-pool UUID (`sub` claim). **Never** key on `email` or `cognito:username`; both are mutable and reassignable in Cognito, and using them as primary keys enables account takeover.

```typescript
resolveIdentity: async (identity) => {
  const user = await findUserBySubject(identity.issuer, identity.subject);
  return user ? { status: "admitted", userId: user.id } : { status: "denied" };
},
```

The runtime validates the ID token and passes `subject` from `claims.sub` — not from the access token.

---

## Cognito groups → roles

Cognito group membership arrives in the ID token as **`cognito:groups`**. This claim is available on **`VerifiedExternalIdentity.idTokenClaims` in `resolveIdentity`** (at login). It is **not** on `SessionPrincipal` — **`resolveAuthorization` does not receive ID token claims**, only `userId`, `issuer`, `subject`, `acr`, and `amr`.

Correct pattern:

1. **At login (`resolveIdentity`)** — read `cognito:groups`, persist to your user record.
2. **Per request (`resolveAuthorization`)** — load roles from your store (derived from stored groups).

```typescript
resolveIdentity: async (identity) => {
  const groups = (identity.idTokenClaims["cognito:groups"] as string[] | undefined) ?? [];
  const userId = await upsertUser(identity.issuer, identity.subject, { groups });
  return { status: "admitted", userId };
},

resolveAuthorization: async (principal) => {
  const roles = await rolesForUser(principal.userId); // from your DB, not idTokenClaims
  return { status: "authorized", roles, scopes: [] };
},
```

If group membership changes in Cognito, existing sessions keep roles from your store until the user logs in again (or you implement your own refresh). Re-run `resolveIdentity` on each login to capture updated groups.

---

## Token endpoint authentication

`@plumbus/auth` uses **`client_secret_post`** for confidential OIDC clients at the token endpoint. Cognito's discovery document does **not** advertise `token_endpoint_auth_methods_supported`; POST is the supported method for app clients with a secret.

The optional `selectClientAuthMethod` integration hook is reserved for future runtime use and is **not** invoked during discovery today.

---

## Logout

Cognito's discovery document does **not** include `end_session_endpoint`. Federated logout uses the hosted UI **`/logout`** endpoint with **`client_id`** + **`logout_uri`** (no ID token hint retained server-side).

Configure:

- `integration.logout.domain` — **required** for federated logout; hosted UI domain (`https://…amazoncognito.com`, path `/` only)
- `providerLogout.returnTo` — relative path combined with `applicationBaseUrl`

If `providerLogout` is set without `logout.domain`, startup emits an advisory warning and `POST /auth/logout` will not return `providerLogoutUrl`.

See [`packages/auth-cognito/instructions/logout.md`](../../packages/auth-cognito/instructions/logout.md).

---

## Validation warnings

`cognito()` runs **`validateRegistration()`** at startup and warns when the issuer URL does not match the expected Cognito IdP pattern. Warnings do not block discovery.

---

## Server-attested sign-in (passwordless apps)

Cognito's hosted login has no magic links, and its custom-auth API is server-to-server. When the application already authenticates people itself — a magic link it mailed, a passkey it verified — and wants Cognito as the directory of record, use the two server-side entry points:

- **`@plumbus/auth-cognito/server`** — runs on the application server (Node, AWS SDK).
- **`@plumbus/auth-cognito/triggers`** — one Lambda function attached to the pool as its `DefineAuthChallenge`, `CreateAuthChallenge` and `VerifyAuthChallengeResponse` triggers. No dependencies beyond `node:crypto`.

The flow, after the app has authenticated the person:

1. `AdminInitiateAuth` with `CUSTOM_AUTH`. The create trigger issues a random nonce.
2. The server answers with an **attestation**: `HMAC-SHA256` over the pool id, the username and the nonce, under a keyring only the server and the trigger hold.
3. The verify trigger checks it; the define trigger allows exactly one challenge, then issues tokens.
4. The server verifies the ID token against the pool's JWKS (issuer, audience, `token_use`, the username it signed in) and revokes the refresh token. The app keeps no Cognito tokens.

An attestation for one pool, user or nonce is useless for any other, so one trigger and one keyring can serve many pools.

```typescript
import {
  createCognitoPoolAdministration,
  createCognitoPoolUsers,
  parseAttestationKeys,
} from "@plumbus/auth-cognito/server";

const attestationKeys = parseAttestationKeys(process.env.COGNITO_ATTESTATION_KEYS); // "k2:secret,k1:old-secret"

// Once per pool (for example per tenant), with pool-administration IAM rights:
const admin = createCognitoPoolAdministration({ region: "eu-west-1" });
const pool = await admin.ensureAttestedUserPool({
  name: "myapp-tenant-a",
  tags: { "myapp:tenant": "tenant-a" },
  triggerArn: process.env.COGNITO_TRIGGER_ARN!,
});

// On every sign-in the app has already verified:
const users = createCognitoPoolUsers({
  region: "eu-west-1",
  userPoolId: pool.userPoolId,
  clientId: pool.clientId,
  attestationKeys,
});
await users.ensureUser({ username: accountId, email });
const identity = await users.signIn({ username: accountId, clientMetadata: { tenant: "tenant-a" } });
// identity.issuer + identity.subject (the immutable `sub`) key the app's identity link.
```

The Lambda is the whole trigger module:

```typescript
import { createAttestedSignInTrigger, parseAttestationKeys } from "@plumbus/auth-cognito/triggers";

export const handler = createAttestedSignInTrigger({
  keys: parseAttestationKeys(process.env.COGNITO_ATTESTATION_KEYS),
});
```

### What `ensureAttestedUserPool` sets

| Setting | Value | Why |
|---|---|---|
| Sign-up | Admin-created users only | Nobody can register themselves, or register someone else's address |
| Account recovery | `admin_only` | Cognito never mails reset codes; the app owns recovery |
| Username | Case-insensitive | Usernames are app-chosen ids |
| Triggers | The one attested sign-in Lambda, three times | Only a keyring holder receives tokens |
| Deletion protection | On | `deleteUserPool` turns it off itself, restating the settings above |
| App client | No secret, `ALLOW_CUSTOM_AUTH` only, token revocation on, user-existence errors hidden, 5-minute ID/access tokens, 60-minute refresh | Admin calls are IAM-signed, the client id never reaches a browser, and the attestation is the real gate |
| Ownership tags | Required | A same-named pool without every tag is refused (`pool-conflict`), never adopted |

It finds the pool by exact name, reconciles the triggers and sign-up/recovery settings if they drifted, and finds the client by name. Every call is idempotent. `ensureUser` creates admin-created users with no Cognito message, the email marked verified, and a random permanent password nobody knows, so the status is `CONFIRMED` (custom auth does not complete for `FORCE_CHANGE_PASSWORD` users).

### Errors

Everything throws `CognitoServerError` with a stable `reason`:

| Reason | Meaning |
|---|---|
| `user-not-found` | No such user (from `getUser`-style calls; `signIn` reports `challenge-refused` because user-existence errors are hidden) |
| `user-disabled` | The user is disabled in the pool |
| `challenge-refused` | Cognito issued no tokens: wrong keyring, unknown user, or an unexpected challenge |
| `token-invalid` | The ID token failed issuer, audience, signature or username checks |
| `pool-not-found` / `pool-conflict` | Missing pool / a pool not owned by the caller |
| `trigger-failed` | The Lambda failed or answered malformed |
| `provider-unavailable` | Network, timeout, throttling or a Cognito fault — retryable |
| `request-refused` | Any other refusal (validation, IAM) |

### Keys and IAM

- Keyring format `id:secret[,id:secret…]`; secrets at least 32 characters; the first key signs, every key verifies. Rotate by adding the new key second on the server and the Lambda, then moving it first.
- Server IAM: `cognito-idp:Admin{GetUser,CreateUser,SetUserPassword,InitiateAuth,RespondToAuthChallenge,EnableUser,DisableUser,UpdateUserAttributes}` on the pools; for administration also `ListUserPools`, `DescribeUserPool`, `CreateUserPool`, `UpdateUserPool`, `DeleteUserPool`, `ListUserPoolClients`, `CreateUserPoolClient`, `GetUserPoolMfaConfig`. Scope by the ownership tag where IAM supports it. `RevokeToken` needs no IAM.
- The Lambda needs a resource policy allowing `cognito-idp.amazonaws.com` to invoke it for the pools' ARNs.

### Administering a hosted-login pool's users

`createCognitoPoolDirectory({ region, userPoolId })` manages a pool's users without signing anyone in — for example an operators pool whose people sign in on the hosted page:

```typescript
import { createCognitoPoolDirectory } from "@plumbus/auth-cognito/server";

const operators = createCognitoPoolDirectory({ region: "eu-west-1", userPoolId });
const invited = await operators.inviteUser({ email: "omer@ops.example", name: "Omer Shahar" });
// Cognito emails a temporary password; invited.status is FORCE_CHANGE_PASSWORD until first sign-in.
await operators.resendInvitation(invited.username); // only while they have not signed in
const everyone = await operators.listUsers(); // username, subject, email, name, enabled, status
await operators.deleteUser(invited.username);
await operators.setUserEnabled(invited.username, false);
```

`inviteUser` answers an existing user with `created: false` instead of failing, so a retried invitation converges. Use the returned `username` for later calls; on a pool that signs in by email Cognito generates it. `inviteUser({ …, sendInvitation: false })` creates the user without any mail (`SUPPRESS`) — nobody knows the temporary password until `resendInvitation` mails the first one — for an invitation someone still has to approve. IAM: `AdminCreateUser`, `AdminGetUser`, `ListUsers`, `AdminEnableUser`, `AdminDisableUser`, `AdminDeleteUser`, `AdminUpdateUserAttributes` on that pool.

### Reading a hosted-login pool's MFA policy

Cognito ID tokens carry no `amr` or `acr`. An app that requires MFA for a hosted-login pool can read the pool's policy instead: `createCognitoPoolAdministration(...).readMfaPolicy(userPoolId)` returns `{ mfa: 'ON' | 'OFF' | 'OPTIONAL', softwareToken, sms, email }`. Federated users skip the pool's MFA; their ID tokens carry an `identities` claim.

---

## Testing without AWS

`@plumbus/auth-cognito/testing` exports **`startFakeCognito()`**: an in-process HTTP server that the real AWS SDK talks to (endpoint override). It covers:

- the pool, client and user actions above, including `ListUsers` and email-as-username pools (`UsernameAttributes: ["email"]`: a user created by address gets a UUID username and answers to the address too);
- custom auth, running the real attested trigger in-process;
- per-pool JWKS and OIDC discovery at `<endpoint>/<poolId>`;
- a minimal hosted login for `@plumbus/auth` (authorize with PKCE, token with client secret).

```typescript
import { startFakeCognito } from "@plumbus/auth-cognito/testing";

const fake = await startFakeCognito({ attestationKeys });
const admin = createCognitoPoolAdministration({ ...fake.clientConfig, maxAttempts: 1 });
// With `endpoint` set, issuers are `<endpoint>/<poolId>` (fake.issuerFor(poolId)).
fake.failAction("AdminInitiateAuth", "InternalErrorException"); // outage until clearFailures()
fake.deliveries(poolId); // invitation emails Cognito would have sent (invitation / resend)
```

The port is random by default. A dev stack that stores issuers (for example in identity links) pins it with `startFakeCognito({ port, host })`, so `<endpoint>/<poolId>` survives restarts.

For hosted login, create a pool and a client with a secret, code grant and callback URL through the SDK, create a user, call `fake.setHostedLoginUser(poolId, username)`, and point the `@plumbus/auth` provider's `issuer` at `fake.issuerFor(poolId)`. `fake.markFederated(poolId, username, "Google")` adds an `identities` claim. `logout.domain` must be HTTPS, so leave it unset against the fake. The fake is not a general Cognito emulator; unknown actions answer `InvalidParameterException`.

---

## Agent instructions

Cognito-specific recipes: [`packages/auth-cognito/instructions/`](../../packages/auth-cognito/instructions/).
