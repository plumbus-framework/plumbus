# Recipe: Expose a capability over the partner API

When the user asks to publish a capability to partners, external systems, or a versioned HTTP API, follow this recipe.

## 1. Mark the capability

Add `exposeAs: ['api']` and an `api` metadata block:

```ts
import { defineCapability } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const getRefund = defineCapability({
  name: "getRefund",
  kind: "query",                                     // query | action (not eventHandler)
  domain: "billing",
  description: "Fetch a refund by id",

  exposeAs: ["api"],
  api: {
    operationId: "getRefund",
    method: "GET",
    path: "/refunds/{refundId}",
    stability: "stable",                             // experimental | beta | stable | deprecated | internal
    auth: { scopes: ["refunds:read"] },
  },

  input: z.object({ refundId: z.string() }),
  output: z.object({ id: z.string(), amount: z.number() }),

  access: {
    roles: ["partner"],
    scopes: ["refunds:read"],
    tenantScoped: true,
  },

  effects: { data: ["Refund"], events: [], external: [], ai: false },

  handler: async (ctx, { refundId }) => ctx.data.Refund.byId(refundId),
});
```

## 2. (Optional) Override in `api.yaml`

When multiple API products or route overrides are needed, maintain a manifest. Inline `api` metadata is the default when `./api.yaml` is missing.

```yaml
apiVersion: plumbus.dev/v1
name: partner-api
basePath: /api/v1

expose:
  - capability: billing.getRefund
    operationId: getRefund
    method: GET
    path: /refunds/{refundId}
```

Manifest entries override inline metadata for the same capability. See [manifest-and-cli.md](./manifest-and-cli.md).

## 3. Register partner routes at bootstrap

```ts
// app/server.ts — export the hook from your app module
import { registerApiRoutes } from "@plumbus/api";

export function onRoutesRegistered(app, routeConfig) {
  registerApiRoutes(app, routeConfig, capabilities, {
    manifest,                                        // parsed ApiManifest or undefined for inline-only
    appRoot: process.cwd(),                          // required for fixture path resolution
    // idempotencyStore: durableStore,               // production: supply durable store + TTL
  });
}
```

Uses the same `authAdapter` and `createDependencies` as convention routes. Partner responses use the `{ ok: true, data }` / `{ ok: false, error }` envelope.

## 4. Validate before shipping

```bash
plumbus api validate
plumbus api generate openapi --out ./dist/openapi.json
plumbus api diff --against ./published/openapi-v1.json
```

## Rules

- **Only `kind: 'query'` and `kind: 'action'` may be API-exposed.** `eventHandler` is rejected at `defineCapability()` time.
- **`exposeAs: ['api']` is required.** A capability without it never appears on the partner surface.
- **Inline `api` metadata must include `operationId`, `method`, and `path`.**
- **Path parameters must map to input fields.** `{refundId}` must exist on the Zod `input` schema. Duplicates in the same path are rejected.
- **`api.auth.scopes` are enforced at runtime.** When both `api.auth.scopes` and `access.scopes` are set, the effective requirement is their union. Missing scopes → `403 missing_scope`.
- **HTTP auth semantics:** missing/invalid credentials → `401 unauthenticated`; authenticated but denied by access → `403 forbidden`.
- **Idempotency:** mutating operations may accept `Idempotency-Key`. Keys are scoped by `operationId`, principal, and header value. Supply a durable `idempotencyStore` in production — see [testing.md](./testing.md).
- **Never combine `access.public: true` with test intent enabled.** `plumbus api validate` flags `policy.public-test-forbidden`.

## What partners see

- **Routes** at `basePath` + per-operation `path` (e.g. `GET /api/v1/refunds/{refundId}`).
- **OpenAPI 3.0.3** generated from Zod schemas + manifest — canonical partner contract from `plumbus api generate openapi`.
- **Same handler, same audit log** as convention HTTP routes — one capability definition, two HTTP surfaces.

## Do not

- Add raw Fastify routes that duplicate capability logic.
- Hand-maintain a separate OpenAPI spec that drifts from Zod schemas.
- Use `plumbus generate` OpenAPI as the partner contract — that thin convention spec is for app-internal use only.
