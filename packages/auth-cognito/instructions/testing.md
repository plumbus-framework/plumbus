# Testing Cognito Integration

Unit-test Cognito options and Cognito-backed flows without AWS credentials.

## Validate options throw early

```ts
import { cognito } from "@plumbus/auth-cognito";

expect(() =>
  cognito({
    hostedLogin: { allowedIdentityProviders: ["Google", "Google"] },
  }),
).toThrow();
```

## Logout URL shape

Import helpers indirectly via integration behavior in `packages/auth-cognito/src/__tests__/cognito.test.ts` — mirror assertions on `buildProviderLogoutUrl` output when customizing.

## Full login flow

Use `@plumbus/auth/testing` **`startFakeOidcProvider()`** for generic OIDC end-to-end tests, or `startFakeCognito()` (below) when the test must look like a Cognito pool — do not depend on Cognito hosted UI in CI.

Apply `cognito()` integration on the fake provider only when testing allowlist param forwarding.

## Fake Cognito (`@plumbus/auth-cognito/testing`)

For anything that talks to Cognito — attested sign-in, pool administration, a full `@plumbus/auth` login against a pool — start the in-process fake. The real AWS SDK talks to it through an endpoint override, and it runs the real attested trigger.

```ts
import { startFakeCognito } from "@plumbus/auth-cognito/testing";
import { createCognitoPoolAdministration, createCognitoPoolUsers } from "@plumbus/auth-cognito/server";

const fake = await startFakeCognito({ attestationKeys });
const admin = createCognitoPoolAdministration({ ...fake.clientConfig, maxAttempts: 1 });
const pool = await admin.ensureAttestedUserPool({ name: "t", tags: { owner: "test" }, triggerArn: "arn:aws:lambda:eu-west-1:0:function:t" });
const users = createCognitoPoolUsers({ ...fake.clientConfig, maxAttempts: 1, ...pool, attestationKeys });

fake.failAction("AdminInitiateAuth", "InternalErrorException"); // outage → provider-unavailable
fake.clearFailures();
afterAll(() => fake.close());
```

- Issuers are `fake.issuerFor(poolId)` (`<endpoint>/<poolId>`); pass the same `endpoint` to the server module.
- Default port is random. For a dev stack that stores issuers (identity links), pin it: `startFakeCognito({ port: 9240, host: "127.0.0.1" })`.
- Hosted login: create a pool and a client with a secret, code grant and callback URL through the SDK, create a confirmed user, then call `fake.setHostedLoginUser(poolId, username)`. `fake.markFederated(...)` adds an `identities` claim. Leave `logout.domain` unset (it must be HTTPS).
- Inspect with `fake.pools()`, `fake.users(poolId)`, `fake.deliveries(poolId)` (invitation emails), `fake.refreshTokens(poolId)`, `fake.calls`, `fake.lastAuthorizeParams(poolId)`.
- A user created with a temporary password (`FORCE_CHANGE_PASSWORD`) becomes `CONFIRMED` at their first hosted sign-in, as if they chose a password.

## Critical rules

- **No live AWS calls in unit tests.**
- **Issuer warnings** from `validateRegistration` are non-fatal — assert separately if needed.

Human docs: [docs/auth/testing.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/testing.md).
