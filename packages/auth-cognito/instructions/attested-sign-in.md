# Server-Attested Sign-In

Use when the app **already authenticates people itself** (a magic link it mailed, a passkey it verified) and must also sign them into an Amazon Cognito user pool: Cognito as the user directory and token issuer, no hosted UI, no passwords, no Cognito-sent mail.

Hosted-login apps do not need this — see [configure-cognito.md](./configure-cognito.md).

## How it works

1. The app authenticates the person with its own mechanism.
2. `users.signIn({ username })` runs `AdminInitiateAuth` with `CUSTOM_AUTH`. The pool's create trigger issues a nonce.
3. The server answers with an HMAC attestation over pool id + username + nonce, under a keyring shared only with the trigger.
4. The trigger verifies it; the define trigger allows exactly one challenge, then Cognito issues tokens.
5. The server verifies the ID token against the pool's JWKS and revokes the refresh token. The result is `{ issuer, subject, username, email?, emailVerified, authTime, claims }`.

## Recipe

```ts
import {
  createCognitoPoolAdministration,
  createCognitoPoolUsers,
  parseAttestationKeys,
  CognitoServerError,
} from "@plumbus/auth-cognito/server";

const attestationKeys = parseAttestationKeys(process.env.COGNITO_ATTESTATION_KEYS);

// Provisioning (idempotent; needs pool-administration IAM):
const admin = createCognitoPoolAdministration({ region });
const { userPoolId, clientId, issuer } = await admin.ensureAttestedUserPool({
  name: `myapp-${tenantKey}`,
  tags: { "myapp:tenant": tenantKey },
  triggerArn,
});

// Sign-in, after the app verified the person:
const users = createCognitoPoolUsers({ region, userPoolId, clientId, attestationKeys });
await users.ensureUser({ username: accountId, email });
const identity = await users.signIn({ username: accountId, clientMetadata: { tenant: tenantKey } });
```

Lambda (one function, attached as all three triggers):

```ts
import { createAttestedSignInTrigger, parseAttestationKeys } from "@plumbus/auth-cognito/triggers";

export const handler = createAttestedSignInTrigger({
  keys: parseAttestationKeys(process.env.COGNITO_ATTESTATION_KEYS),
});
```

## Identity

- Key the app's identity link on **`identity.issuer` + `identity.subject`** (`sub`, immutable per pool). One pool per tenant gives each tenant its own issuer.
- Choose the **username** yourself (for example the app's account id). Never look Cognito users up by email to decide who someone is.
- `ensureUser` is idempotent and repairs a user left in `FORCE_CHANGE_PASSWORD` by an interrupted create.

## Errors

`CognitoServerError.reason`: `user-not-found`, `user-disabled`, `challenge-refused`, `token-invalid`, `pool-not-found`, `pool-conflict`, `trigger-failed`, `provider-unavailable` (retryable), `request-refused`.

- A disabled Cognito user → `user-disabled` from `signIn`.
- A missing user or a wrong keyring → `challenge-refused` (the client hides user existence).
- Map `provider-unavailable` to a retryable response. Fail closed on every other reason.

## Keys

- Format `id:secret[,id:secret…]`; secrets ≥ 32 characters; the **first key signs**, every key verifies.
- Rotate: add the new key second on server and Lambda → deploy both → move it first → deploy → drop the old key.
- The same keyring can serve every pool; attestations are bound to the pool id.

## Critical rules

1. **Call `signIn` only after the app has authenticated the person.** The keyring holder can sign in as anyone.
2. **Never pass request input straight into `username`** — resolve the account first.
3. **Do not store Cognito tokens.** The app keeps its own session; the refresh token is revoked on sign-in.
4. **Use `ensureAttestedUserPool` for pools** so sign-up stays admin-only, recovery stays `admin_only`, and ownership tags are checked. Hand-built pools must match the settings table in the human docs.
5. **`deleteUserPool` requires the ownership tags** and refuses foreign pools.

Human docs: [docs/auth/cognito.md → Server-attested sign-in](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/cognito.md#server-attested-sign-in-passwordless-apps).
