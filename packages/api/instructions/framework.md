# @plumbus/api — Framework

`@plumbus/api` is the **partner external API contract layer** for Plumbus apps. It serves capabilities marked `exposeAs: ['api']` on versioned partner routes with OpenAPI export, docs generation, compatibility diff, and test intent. It is an **optional peer** of `@plumbus/core` (version-locked `0.1.x`; requires `@plumbus/core` `0.5.x`).

## Package boundary

| Concern | Owned by |
|---|---|
| `exposeAs` field and inline `api` metadata on `defineCapability` | `@plumbus/core` |
| `plumbus api validate` / `generate` / `diff` / `test-fixtures validate` CLI commands | `@plumbus/core` (dynamic import of `@plumbus/api`) |
| Advisory API governance rules in `plumbus verify` | `@plumbus/core` |
| `registerApiRoutes` runtime, partner envelope, idempotency, test intent | `@plumbus/api` |
| Manifest parse/validate, OpenAPI/docs generation, compatibility diff | `@plumbus/api` |
| Structure policy and fixture validation | `@plumbus/api` |

This split lets apps validate contracts in CI without mounting partner routes, and keeps the runtime swappable.

## When to install

Install `@plumbus/api` when the app needs a **published partner-facing HTTP API** with manifest validation, OpenAPI export, and `registerApiRoutes()`. Skip it when:

- Only app-internal convention routes (`/api/{domain}/{kebab-name}`) are needed — default `@plumbus/core` HTTP is enough.
- Only AI agent exposure is needed — use `@plumbus/mcp` instead (`pnpm add @plumbus/mcp`; see `node_modules/@plumbus/mcp/instructions/` when installed).
- Only a typed Next.js client is needed — use `@plumbus/ui` (`pnpm add @plumbus/ui`; see `node_modules/@plumbus/ui/instructions/` when installed).

```bash
pnpm add @plumbus/api
```

If agent wiring predates the current template, run `plumbus init --patch` (or `plumbus init --patch --agent agents-md` for `AGENTS.md` only) and `plumbus doctor` to confirm. Wiring already at the current version only needs the package install — instruction paths in `node_modules/@plumbus/api/instructions/` become resolvable without a patch.

`plumbus api validate` prints an install hint when the package is missing. Do **not** add Zod or Vitest to the app's `package.json` for API work — `@plumbus/core` provides them transitively.

## Public exports

```ts
// from '@plumbus/api'
registerApiRoutes(app, routeConfig, capabilities, opts?)  // mount partner routes on Fastify
RegisterApiRoutesOpts                                     // { manifest?, allowQueryIntent?, appRoot?, idempotencyStore? }

parseManifest, validateManifest, resolveExposure, buildDefaultManifest
validatePathParams, validateApiContract, validatePolicy, validateTestFixtures

generateOpenApi, serializeOpenApiDocument, parseOpenApiDocument, zodToOpenApiSchema
generateApiDocs
diffOpenApi

buildSuccessEnvelope, mapCoreError, mapUnknownError, mapApiErrorCode, ...
createInMemoryIdempotencyStore, parseIdempotencyTtl, IdempotencyAbortedError

ApiManifestError
```

## File map (`src/`)

```
src/
├── index.ts                    # public barrel
├── validate.ts                 # validateApiContract — combined manifest/policy/fixture checks
├── manifest/                   # parse, resolve, path-params, default manifest
├── openapi/                    # OpenAPI 3.0.3 generation + Zod → JSON Schema
├── docs/                       # Markdown API reference generation
├── diff/                       # breaking / non-breaking OpenAPI diff
├── policy/                     # structure policy validation
└── runtime/
    ├── register-routes.ts      # registerApiRoutes — Fastify partner surface
    ├── envelope.ts             # partner success/error envelopes
    ├── idempotency.ts          # Idempotency-Key store (in-memory default)
    ├── test-intent.ts          # ?intent=test / header-driven fixture replay
    └── validate-fixtures.ts    # fixture schema validation
```

## Critical rules

1. **Capability runtime is unchanged.** Every partner HTTP request goes through the same `executeCapability` pipeline as convention routes — validation, access policy, audit. The API layer is a thin adapter; it never re-implements those.
2. **Per-request `ExecutionContext`.** Auth adapter + `createDependencies` produce a fresh `ctx` per request; do not reuse across concurrent calls.
3. **`@plumbus/core` MUST NOT import from `@plumbus/api`.** The dependency points one way. CLI commands in core use dynamic import only.
4. **Never bypass Plumbus primitives for business logic.** Partner routes dispatch to existing capability handlers. Do not add parallel Fastify handlers that duplicate entity access, auth, or audit.
5. **Convention routes may coexist.** Partner routes use manifest `basePath` + per-operation `path`. Default `/api/{domain}/{kebab-name}` routes remain unless the app chooses not to register them.
6. **OAuth gateways and rate limiting are app-owned.** This package validates contracts and mounts routes; perimeter concerns stay in app middleware or infrastructure.

## Where to look for more

Conceptual bridge (core surface, install, CLI entry points): `node_modules/@plumbus/core/instructions/api.md`.

Package README (install, quick start, exports, CLI): `node_modules/@plumbus/api/README.md` (or [`../README.md`](../README.md) from this folder).
