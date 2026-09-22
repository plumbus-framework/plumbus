# Testing Cognito Integration

Unit-test Cognito options without AWS credentials.

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

Use `@plumbus/auth/testing` **`startFakeOidcProvider()`** for end-to-end tests — do not depend on Cognito hosted UI in CI.

Apply `cognito()` integration on the fake provider only when testing allowlist param forwarding.

## Critical rules

- **No live AWS calls in unit tests.**
- **Issuer warnings** from `validateRegistration` are non-fatal — assert separately if needed.

Human docs: [docs/auth/testing.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/testing.md).
