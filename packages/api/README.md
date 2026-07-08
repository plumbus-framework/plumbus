# @plumbus/api

> **Partner-grade external API contracts for [Plumbus](https://github.com/plumbus-framework/plumbus) apps.** Mark capabilities with `exposeAs: ['api']`, maintain an `api.yaml` manifest, and serve a versioned partner surface — with **the same validation, access policies, audit pipeline, and Zod schemas** as your default HTTP routes.

[![npm](https://img.shields.io/npm/v/@plumbus/api.svg)](https://www.npmjs.com/package/@plumbus/api)
[![license](https://img.shields.io/npm/l/@plumbus/api.svg)](./LICENSE)
[![peer: @plumbus/core 0.5.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.5.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![OpenAPI 3.0.3](https://img.shields.io/badge/OpenAPI-3.0.3-6BA539)](https://www.openapis.org)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. You declare capabilities, entities, events, flows, prompts, and translations through `define*()` functions; the framework generates routes, validation, audit, security, and types.

`@plumbus/api` is the **external API contract layer** for that framework. It layers a named, partner-facing HTTP surface on top of the default convention routes in `@plumbus/core` — custom paths, API versioning, OpenAPI export, Markdown docs, compatibility diffing, and test-intent fixtures — without duplicating handlers, auth, or audit.

If you're not using Plumbus, this package can't be used in isolation. The runtime composes on `executeCapability` and the framework's access-policy pipeline; it doesn't re-implement REST dispatch from scratch.

## Why?

If you've ever published an API for partners, you've probably written something like:

- A second route table with hand-maintained paths and methods
- A separate OpenAPI spec that drifts from the real handlers
- Ad-hoc breaking-change checks before each release
- Fixture files that nobody validates against Zod schemas

Plumbus already has typed capability contracts. This package projects them into a versioned partner API with generated OpenAPI, docs, and CI-friendly diff. **One handler, two HTTP surfaces, one audit log.**

## What you get

| Surface | What it does |
|---|---|
| **`exposeAs: ['api']` + `api` metadata** | Opt-in projection per capability — `operationId`, `method`, `path`, `stability`, `auth.scopes`. |
| **`api.yaml` manifest** | Named API products (`basePath`, version, route overrides, test-intent config). Inline metadata is the default when no manifest exists. |
| **`registerApiRoutes()`** | Mount partner routes on Fastify. Full pipeline: Zod validation → scope check → access policy → handler → audit → envelope. |
| **OpenAPI 3.0.3** | `generateOpenApi` / `plumbus api generate openapi` from Zod schemas + manifest. Canonical partner spec (distinct from the thin `plumbus generate` convention spec). |
| **Markdown docs** | `generateApiDocs` / `plumbus api generate docs` — per-operation reference pages. |
| **Compatibility diff** | `diffOpenApi` / `plumbus api diff --against` — breaking vs non-breaking change report for CI. |
| **Test intent** | `?intent=test` / header-driven fixture replay for partner integration tests (validated by `plumbus api test-fixtures validate`). |
| **Idempotency** | `Idempotency-Key` support with pluggable store; in-memory default for dev/tests. |
| **Policy validation** | Structure policy, path-param mapping, fixture schema checks — surfaced in `plumbus api validate`. |
| **Governance** | Advisory API rules also run in `plumbus verify` when capabilities expose the API surface. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| App-internal routes for your own UI (`/api/{domain}/{kebab-name}`) | Default HTTP runtime in `@plumbus/core` |
| Typed client generation for your Next.js app | [`@plumbus/ui`](../ui/) |
| Expose a capability to an AI agent | [`@plumbus/mcp`](../mcp/) |
| **Versioned, documented partner API with OpenAPI + diff** | **`@plumbus/api`** (this package) |

## Status

Optional peer of `@plumbus/core` (version-locked `0.1.x`; requires `@plumbus/core` `0.5.x`). Implements manifest validation, route registration, OpenAPI/docs generation, compatibility diff, test intent, and idempotency. OAuth gateways, rate limiting, and durable idempotency stores are app-owned — see [Key gotchas](#key-gotchas).

## Install

```bash
pnpm add @plumbus/api
```

If your agent wiring (`AGENTS.md`, Cursor, Copilot) predates the current template, refresh it so agents discover these instructions:

```bash
plumbus init --patch --agent agents-md   # AGENTS.md only; omit --agent for all formats
plumbus doctor                           # confirms wiring is current
```

`@plumbus/core` works without `@plumbus/api` — default convention routes and `plumbus generate` still run. Install this package when you want a **published partner API** with manifest validation, OpenAPI export, and `registerApiRoutes()`. `plumbus api validate` prints an install hint when the package is missing.

Peer: `@plumbus/core` `0.5.x`. The framework provides Zod and Vitest transitively — do not add them to your own `package.json` for API work.

## Quick start

### 1. Mark a capability for API exposure

```typescript
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const getRefund = defineCapability({
  name: 'getRefund',
  kind: 'query',
  domain: 'billing',
  description: 'Fetch a refund by id',

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

### 2. (Optional) Maintain `api.yaml`

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

When `./api.yaml` is missing, the CLI and runtime fall back to inline `api` metadata. An explicit `--manifest` path that is missing or invalid fails with a clear error.

### 3. Register partner routes

```typescript
import { registerApiRoutes } from '@plumbus/api';
import { onRoutesRegistered } from '@plumbus/core';
import manifest from './api.yaml' assert { type: 'yaml' }; // or load at boot

onRoutesRegistered(async (app, routeConfig) => {
  await registerApiRoutes(app, routeConfig, capabilities, { manifest });
});
```

### 4. Validate and publish artifacts

```bash
plumbus api validate
plumbus api validate --fail-on-governance   # optional CI gate on advisory apiRules
plumbus api generate openapi --out ./dist/openapi.json
plumbus api generate docs --out ./dist/api-docs
plumbus api diff --against ./published/openapi-v1.json
plumbus api test-fixtures validate
```

Governance signals from `plumbus api validate` are advisory unless `--fail-on-governance` is set. Hard contract findings always fail the command.

## How requests flow

```
partner HTTP request
       │
       ▼
 authAdapter.authenticate(credentials)     ← same adapter as convention routes
       │
       ▼
 scope check (api.auth.scopes)             ← missing scope → 403 missing_scope
       │
       ▼
 createExecutionContext + evaluateAccess
       │
       ▼
 executeCapability(cap, ctx, args)         ← full Plumbus pipeline:
       │                                      Zod validation → access policy
       │                                      → handler → audit → output validation
       ▼
 { ok: true, data } | { ok: false, error }  ← partner envelope
```

Convention routes (`/api/{domain}/{kebab-name}`) continue to exist unless you choose not to register them. Partner routes use manifest `basePath` + per-operation `path`.

## Public API

| Export | Purpose |
|---|---|
| `registerApiRoutes(app, routeConfig, capabilities, opts?)` | Mount partner API routes on Fastify. Opts: `manifest`, `allowQueryIntent`, `appRoot`, `idempotencyStore`. |
| `parseManifest`, `validateManifest`, `resolveExposure`, `buildDefaultManifest` | Manifest load, validation, and exposure resolution. |
| `validatePathParams` | Path-template ↔ input-field mapping checks. |
| `generateOpenApi`, `serializeOpenApiDocument`, `parseOpenApiDocument`, `zodToOpenApiSchema` | OpenAPI 3.0.3 generation and serialization. |
| `diffOpenApi` | Breaking / non-breaking diff between two OpenAPI documents. |
| `generateApiDocs` | Markdown documentation per operation. |
| `validateApiContract` | Combined manifest, policy, path-param, and fixture validation. |
| `validatePolicy`, `validateTestFixtures` | Structure-policy and test-fixture validation. |
| `buildSuccessEnvelope`, `mapCoreError`, `mapUnknownError`, … | Partner response envelope helpers. |
| `createInMemoryIdempotencyStore`, `parseIdempotencyTtl`, `IdempotencyAbortedError` | Idempotency store for dev/tests; supply a durable store in production. |
| `ApiManifestError` | Structured manifest parse/validation errors. |

## CLI

Commands ship in `@plumbus/core` and dynamically import this package:

| Command | Purpose |
|---|---|
| `plumbus api validate` | Manifest, policy, path params, fixtures, and advisory governance. |
| `plumbus api generate openapi --out <file>` | Write OpenAPI JSON or YAML (`--format yaml`). |
| `plumbus api generate docs --out <dir>` | Write Markdown API reference. |
| `plumbus api diff --against <file>` | Compare current spec to a published baseline; exits non-zero on breaking changes. |
| `plumbus api test-fixtures validate` | Validate test-intent fixture files against capability schemas. |

All commands accept `--manifest <path>` (default `./api.yaml`) and `--json` where applicable.

## Key gotchas

- **`exposeAs: ['api']` is required.** There is no `api.expose` boolean. `kind: 'eventHandler'` capabilities cannot be API-exposed.
- **`api.auth.scopes` are enforced at runtime** (union with `access.scopes` when both are set). Missing scopes return `403 missing_scope`.
- **Path parameters must map to input fields.** `{refundId}` in the route must exist on the capability `input` schema. Duplicates in the same path are rejected.
- **Default idempotency store is in-memory.** Fine for dev and single-instance tests; production multi-instance deployments need a durable `idempotencyStore` with TTL.
- **`plumbus generate` OpenAPI ≠ partner OpenAPI.** The thin convention spec from `plumbus generate` is for app-internal use; `plumbus api generate openapi` is the canonical partner contract.
- **Public capabilities + test intent is forbidden.** `plumbus api validate` flags `policy.public-test-forbidden` when `access.public: true` enables test fixtures.

## Documentation

- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/api/instructions/`):
  - [`instructions/framework.md`](./instructions/framework.md) — package boundary, public exports, critical rules
  - [`instructions/expose-a-capability.md`](./instructions/expose-a-capability.md) — full recipe with `exposeAs`, `api` metadata, bootstrap
  - [`instructions/manifest-and-cli.md`](./instructions/manifest-and-cli.md) — `api.yaml`, validation, OpenAPI/docs, diff, CLI
  - [`instructions/testing.md`](./instructions/testing.md) — test intent, idempotency, fixture validation, route tests
- **Concepts and reference** (in the monorepo): [`docs/api/`](../../docs/api/)
  - [`overview.md`](../../docs/api/overview.md) — surfaces, workflow, monorepo relationship
  - [`exposure-model.md`](../../docs/api/exposure-model.md) — `exposeAs`, inline `api` metadata, auth, idempotency
  - [`manifest.md`](../../docs/api/manifest.md) — `api.yaml` structure and precedence
  - [`openapi.md`](../../docs/api/openapi.md) — OpenAPI generation and formats
  - [`structure-policy.md`](../../docs/api/structure-policy.md) — API structure policy rules
  - [`test-intent.md`](../../docs/api/test-intent.md) — fixture replay and validation
  - [`compatibility.md`](../../docs/api/compatibility.md) — breaking-change diff workflow
  - [`governance.md`](../../docs/api/governance.md) — advisory rules in verify and validate

## The Plumbus ecosystem

| Package | Purpose | When to install |
|---|---|---|
| [`@plumbus/core`](../plumbus-core/) | Foundation — capabilities, entities, events, flows, prompts, translations, runtime, CLI, audit, governance. | Always (required). |
| [`@plumbus/ui`](../ui/) | Next.js/React UI — typed API clients, auth helpers, form metadata, scaffolds. | When building a Plumbus web UI. |
| **`@plumbus/api`** | **You are here.** Partner external API — manifest, OpenAPI, docs, compatibility diff, test intent. | Optional peer `0.1.x` — when publishing a documented partner-facing HTTP API. |
| [`@plumbus/mcp`](../mcp/) | MCP runtime — serve capabilities to AI agents (`tools/*`, `tasks/*`, transports). | Optional peer `0.5.x` — when exposing capabilities to MCP clients. |
| [`@plumbus/chat`](../chat/) | Conversational runtime — `defineChat`, policy guards, context sources, streamed events. | Optional peer `0.1.x` — when adding a chat surface. |
| [`@plumbus/chat-ui`](../chat-ui/) | React chat UI — hooks and `<ChatPanel />` for the `@plumbus/chat` turn protocol. | Peer of `@plumbus/chat` — when adding a browser chat client. |
| [`@plumbus/knowledge-base`](../knowledge-base/) | Knowledge providers — scoped sources, registry, chat `knowledgeContext` integration. | Optional peer of `@plumbus/chat` `0.1.x` — when sharing named knowledge across features. |
| [`@plumbus/voice`](../voice/) | Real-time voice runtime — `defineVoice`, STT/TTS/transport providers, session worker, cost ledger. | Optional peer `0.1.x` — when adding speech I/O (not speech-to-speech); complements `@plumbus/chat` text surfaces. |
| [`@plumbus/browser-extension`](../browser-extension/) | Extension scaffolder — WXT Chrome/Firefox project wired to your capabilities. | With `@plumbus/ui` (`0.1.x`) — when shipping a browser extension UI. |

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## Testing

Framework developers run package tests from the monorepo:

```bash
cd packages/api && pnpm test
```

Consumer apps validate contracts via `plumbus api validate` and `plumbus api test-fixtures validate`. Route behavior is covered by integration tests that call `registerApiRoutes` with `createTestContext` from `@plumbus/core/testing`.

## License

MIT
