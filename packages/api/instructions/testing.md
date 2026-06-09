# Recipe: Testing partner API behavior

Use this file for test intent, idempotency, fixture validation, and route integration tests.

## Test intent

Partners test integrations safely with explicit test intent:

```http
POST /api/v1/refunds/123/approve
Authorization: Bearer <token>
X-Plumbus-Intent: test
X-Plumbus-Test-Mode: safe-reply
```

Or query param `?intent=test` when `allowQueryIntent: true` is passed to `registerApiRoutes` (dev/test only — avoid in production).

**Modes:**

- `validate-only` — auth, scopes, and input validation only; no handler execution.
- `safe-reply` — returns a fixture validated against the output schema; no handler execution.

**Configure on the capability or manifest entry:**

```ts
api: {
  operationId: "approveRefund",
  method: "POST",
  path: "/refunds/{refundId}/approve",
  test: {
    enabled: true,
    modes: ["validate-only", "safe-reply"],
    defaultMode: "safe-reply",
    safeReply: { fixture: "fixtures/refunds/approve-success.json" },
  },
},
```

**Rules:**

- Test intent requires an authenticated (non-anonymous) identity.
- Normal scope and access checks still apply after authentication.
- Public capabilities (`access.public: true`) must not enable test intent — `policy.public-test-forbidden`. Runtime rejects test intent on public endpoints with `400 test_intent_not_supported`.
- Fixture paths must be relative to `appRoot` and stay within it (`../` escapes are rejected).
- Validate fixtures: `plumbus api test-fixtures validate`.

## Idempotency

Mutating partner operations may accept `Idempotency-Key` (default header name).

```ts
import { createInMemoryIdempotencyStore, parseIdempotencyTtl } from "@plumbus/api";

await registerApiRoutes(app, routeConfig, capabilities, {
  idempotencyStore: createInMemoryIdempotencyStore(),  // dev/tests only
});
```

**Production:** supply a durable `IdempotencyStore` with TTL for multi-instance deployments. The in-memory default never evicts entries without `idempotency.ttl`, and does not survive restarts.

**Semantics:**

- Keys scoped by `operationId`, principal (`tenantId`/`userId`), and header value.
- Required idempotency demands an identifiable principal (`userId` or `tenantId`); anonymous callers receive `401 unauthenticated`.
- Concurrent duplicates wait for the first result and receive the same success envelope on replay.
- Failed outcomes are not cached — duplicates re-claim independently.

## Route integration tests

Test through `registerApiRoutes` with a real Fastify app and `createTestContext` from `@plumbus/core/testing`:

```ts
import { registerApiRoutes } from "@plumbus/api";
import { createTestContext } from "@plumbus/core/testing";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

describe("partner API", () => {
  it("returns refund envelope", async () => {
    const app = Fastify();
    const routeConfig = {
      authAdapter: testAuthAdapter,
      createDependencies: () => createTestContext(),
      capabilities,
    };
    await registerApiRoutes(app, routeConfig, capabilities);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/refunds/ref-1",
      headers: { authorization: "Bearer partner-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { id: "ref-1", amount: 100 } });
  });
});
```

Run capability logic through `runCapability()` / `simulateFlow()` for unit tests; use route injection for HTTP envelope, scope, and idempotency behavior.

## CI checklist

```bash
plumbus api validate
plumbus api test-fixtures validate
plumbus api diff --against ./published/openapi-v1.json
```

All three should pass before publishing a new partner API version.
