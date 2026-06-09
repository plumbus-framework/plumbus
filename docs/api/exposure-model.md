# API Exposure Model

Partner HTTP exposure uses the same `exposeAs` pattern as MCP: you opt in per capability with `exposeAs: ['api']` and attach an `api` metadata block that describes how the capability maps to HTTP.

The capability contract (Zod schemas, `access`, `handler`) remains the source of truth. The `api` block and optional manifest entry only control **projection** — route path, method, documented scopes, idempotency, and test fixtures.

**Previous:** [overview.md](./overview.md) · **Next:** [manifest.md](./manifest.md)

---

## When to expose a capability over the partner API

Expose a capability when:

- External systems (not your own UI) need a stable, versioned HTTP contract.
- You want OpenAPI and compatibility diff generated from the same Zod schemas as runtime validation.
- Partners need documented OAuth scopes and optional test-intent fixtures.

Do **not** expose when:

- Only your Next.js app calls the capability — use convention routes.
- The capability is a background `job` or an `eventHandler` — these kinds are rejected at `defineCapability()` time.
- You only need AI agent access — use [`exposeAs: ['mcp'`](../mcp/expose-a-capability.md) instead.

---

## Basic example

```typescript
defineCapability({
  name: 'getRefund',
  kind: 'query',
  domain: 'billing',
  exposeAs: ['api'],
  api: {
    operationId: 'getRefund',
    method: 'GET',
    path: '/refunds/{refundId}',
    stability: 'stable',
    auth: { scopes: ['refunds:read'] },
  },
  input: z.object({ refundId: z.string() }),
  output: z.object({ id: z.string(), amount: z.number() }),
  access: { roles: ['partner'], scopes: ['refunds:read'], tenantScoped: true },
  effects: { data: ['Refund'], events: [], external: [], ai: false },
  handler: async (ctx, { refundId }) => ctx.data.Refund.byId(refundId),
});
```

Partners call `GET /api/v1/refunds/{refundId}` (when `basePath` is `/api/v1`). The handler is identical to what convention routes would invoke.

---

## Eligible capability kinds

`defineCapability()` validates exposure at definition time:

| Kind | API exposure | Notes |
|---|---|---|
| `query` | Allowed | Typically mapped to `GET` with query parameters for non-path input fields. |
| `action` | Allowed | Typically `POST`, `PATCH`, `PUT`, or `DELETE`. |
| `eventHandler` | **Rejected** | `eventHandler cannot be exposed via API` |
| `job` | **Rejected** | `job cannot be exposed via API` — jobs use async convention routes with `202` semantics; they are not part of the partner contract layer. |

There is no `api.expose` boolean. `exposeAs: ['api']` is the only opt-in flag, and an `api` block with `operationId`, `method`, and `path` is required when exposure is enabled.

---

## The `api` metadata block

All fields are defined on `ApiExposureConfig` in `@plumbus/core` and validated by Zod at `defineCapability()` time.

| Field | Required | Purpose |
|---|---|---|
| `operationId` | Yes | Stable identifier for OpenAPI, audit events (`api.{operationId}`), and idempotency scoping. |
| `method` | Yes | `GET`, `POST`, `PATCH`, `PUT`, or `DELETE`. |
| `path` | Yes | Route-relative path with `{param}` tokens (e.g. `/refunds/{refundId}`). |
| `stability` | No | `experimental`, `beta`, `stable`, `deprecated`, or `internal`. `deprecated` sets OpenAPI `deprecated: true`. |
| `auth.scopes` | No | OAuth scopes documented and enforced at runtime. |
| `idempotency` | No | `{ required, header, ttl? }` for mutating operations. |
| `test` | No | Test-intent configuration (see [test-intent](./test-intent.md)). |
| `docs` | No | `summary`, `description`, `tags` overrides for OpenAPI/Markdown. |
| `deprecation` | No | `sunset`, `replacement` operationId for deprecated operations. |

### Mutating operation with idempotency

```typescript
api: {
  operationId: 'approveRefund',
  method: 'POST',
  path: '/refunds/{refundId}/approve',
  auth: { scopes: ['refunds:write'] },
  idempotency: {
    required: true,
    header: 'Idempotency-Key',
    ttl: '24h',
  },
},
```

---

## Precedence: inline vs manifest

Exposure metadata can live inline on the capability or be overridden per entry in `api.yaml`. Resolution is implemented in `resolveExposure()`:

1. **Capability contract** defines schemas, `exposeAs: ['api']`, and the inline `api` block (required).
2. **Inline `api` metadata** is the default projection when no manifest entry exists for that capability.
3. **Manifest entries** override route-level fields for the named API product: `operationId`, `method`, `path`, `stability`, `auth`, `idempotency`, `test`, `docs`, `deprecation`.
4. A manifest **cannot** expose a capability that lacks `exposeAs: ['api']` — validation fails with `manifest.capability-not-exposed`.

Manifest entries are keyed by `capability: <domain>.<name>` (e.g. `billing.getRefund`).

When `./api.yaml` is missing, `buildDefaultManifest()` synthesizes a manifest from all API-exposed capabilities with `basePath: /api/v1`.

---

## HTTP auth semantics

Partner routes use the same `authAdapter` as convention routes. The runtime distinguishes three outcomes:

| Situation | HTTP status | Error code |
|---|---|---|
| Missing `Authorization` on a non-public endpoint | 401 | `unauthenticated` |
| `Authorization` present but adapter returns `null` | 401 | `unauthenticated` |
| Authenticated but `evaluateAccess` denies | 403 | `forbidden` |
| Authenticated but missing required scope | 403 | `missing_scope` |

Public capabilities (`access.public: true`) allow anonymous access when no auth header is sent. If a caller **does** send a header, it must still authenticate successfully.

---

## Scope enforcement

Runtime and OpenAPI use the **union** of `api.auth.scopes` and `access.scopes`:

```typescript
// requiredApiScopes(resolved.auth?.scopes, cap.access?.scopes)
// → unique merge of both arrays
```

If either side declares `['refunds:read', 'billing:read']` and the other declares `['refunds:read']`, the caller needs all three unique scopes. Document scopes in both places when partner-facing scope names differ from internal access policy names.

---

## Path parameters

Path template tokens must map to fields on the capability `input` Zod object:

- `{refundId}` in `/refunds/{refundId}` requires `refundId` on `input`.
- Duplicate `{param}` tokens in the same path are rejected (`manifest.path-param-collision`).
- Unmapped tokens fail validation (`manifest.path-param-unmapped`).
- At runtime, path params are merged into the parsed input; conflicting values between path and body/query raise a validation error.

See [manifest.md](./manifest.md) for the full path-param error catalog.

---

## Idempotency

Mutating partner operations can require an `Idempotency-Key` header (name configurable via `idempotency.header`).

### Key scoping

Store keys are built from:

```
{operationId}:{tenantId}:{userId}:{idempotencyKey}
```

Cross-principal reuse of the same key returns `409 idempotency_conflict` (`Idempotency key belongs to a different principal`). Reuse with a different payload hash returns `409` with `Idempotency key reused with different payload`.

### Anonymous guard

When `idempotency.required` is true, the principal must have `userId` or `tenantId`. Anonymous principals (`userId` and `tenantId` both undefined) receive **`401 unauthenticated`** before the idempotency store is consulted — even on otherwise-public endpoints.

### Success and failure paths

- **Success:** concurrent requests with the same key execute the handler once; duplicates wait for the first result and receive the same success envelope on replay.
- **Failure:** when the first in-flight request fails (handler throw or business error), the store aborts the claim and releases waiters. Duplicates re-claim independently — failed outcomes are **not** cached for replay.

### Payload hashing

Hashes use canonical JSON (sorted object keys at every nesting level) so equivalent objects produce the same hash regardless of key order.

### Store and TTL

`registerApiRoutes()` defaults to `createInMemoryIdempotencyStore()` — suitable for development and single-instance tests.

| Behavior | In-memory default |
|---|---|
| No `idempotency.ttl` | Entries never evict |
| `ttl` set (e.g. `24h`) | Expiry honored on subsequent claims after successful completion |
| Multi-instance production | Supply a durable `idempotencyStore` implementing `IdempotencyStore` |

TTL strings parse as `\d+[smhd]` (e.g. `30m`, `24h`, `7d`).

```typescript
import { createInMemoryIdempotencyStore } from '@plumbus/api';

await registerApiRoutes(app, routeConfig, capabilities, {
  idempotencyStore: createInMemoryIdempotencyStore(), // dev/tests only
});
```

---

## Response envelope

Partner responses wrap capability output in a consistent envelope:

**Success (live):**

```json
{
  "ok": true,
  "data": { "id": "ref-1", "amount": 100 },
  "meta": { "requestId": "…", "apiVersion": "v1" }
}
```

**Error:**

```json
{
  "ok": false,
  "error": {
    "code": "validation_failed",
    "message": "Invalid input",
    "details": [{ "path": "refundId", "message": "Required" }],
    "requestId": "…"
  },
  "meta": { "apiVersion": "v1" }
}
```

Internal errors map to a generic `internal_error` message. Validation errors include structured `error.details` when Zod issues are available.

---

## Convention routes coexist

Default core routes (`/api/{domain}/{kebab-name}`) continue to exist unless you choose not to register them. Partner routes mount at `manifest.basePath + resolved.path`. Both surfaces call the same handler through `executeCapability`.

---

## Related topics

- [manifest.md](./manifest.md) — `api.yaml` structure and validation
- [openapi.md](./openapi.md) — how exposure metadata becomes OpenAPI operations
- [test-intent.md](./test-intent.md) — safe partner testing without side effects
- [structure-policy.md](./structure-policy.md) — tenant routing and GET semantics
- [governance.md](./governance.md) — advisory warnings for incomplete metadata
