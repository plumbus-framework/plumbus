# Partner API / External API (`@plumbus/api`)

The Plumbus framework's partner-facing HTTP contract layer. You mark capabilities with `exposeAs: ['api']`, optionally maintain an `api.yaml` manifest, and serve versioned routes with generated OpenAPI, Markdown docs, compatibility diffing, and safe test-intent fixtures — all backed by the **same Zod schemas, access policies, audit pipeline, and handlers** as your default convention routes.

The runtime lives in [`packages/api`](../../packages/api). CLI commands (`plumbus api validate`, `generate`, `diff`) ship in `@plumbus/core` and dynamically import `@plumbus/api` when installed.

These docs are split in two:

- **Usage** (the files in this folder) — how to expose capabilities, validate contracts, publish OpenAPI, and test partner integrations. Human-readable, explanatory.
- **Agent instructions** — prescriptive recipes for AI coding agents. Lives at [`packages/api/instructions/`](../../packages/api/instructions/) and ships in the npm tarball so agents working in `node_modules/@plumbus/api/` can find it. The instructions cross-link back to these docs for the deeper conceptual material.

**This page is the folder index.** For install, mental model, architecture diagrams, quick start, and request lifecycle, read **[overview.md](./overview.md)** — the detailed getting-started guide. Start here for navigation; go to overview when you are ready to implement.

Package README (install, exports, CLI quick reference): [`packages/api/README.md`](../../packages/api/README.md).

## Usage docs

| Doc | Read when… |
|---|---|
| [overview.md](./overview.md) | You want the full picture: when to use partner API, mental model, install, end-to-end quick start, request lifecycle, and surfaces compared. |
| [exposure-model.md](./exposure-model.md) | You want to understand `exposeAs`, the `api` metadata block, auth scopes, idempotency, and which capability kinds can be exposed. |
| [manifest.md](./manifest.md) | You are authoring or validating `api.yaml`, or need the field-by-field reference and error catalog. |
| [openapi.md](./openapi.md) | You are generating or publishing OpenAPI, or need servers/paths, security schemes, and envelope components. |
| [test-intent.md](./test-intent.md) | Partners need safe integration testing with fixtures, or you are configuring `validate-only` / `safe-reply` modes. |
| [structure-policy.md](./structure-policy.md) | You need tenant routing rules, GET semantics, or the public+test guard. |
| [compatibility.md](./compatibility.md) | You are diffing API versions in CI or deciding whether a change is breaking. |
| [governance.md](./governance.md) | You want advisory warnings from `plumbus verify` and how they relate to `plumbus api validate`. |

## Suggested reading paths

| Goal | Path |
|---|---|
| **New to partner API** | [overview.md](./overview.md) → [exposure-model.md](./exposure-model.md) → [manifest.md](./manifest.md) |
| **Publishing OpenAPI** | [exposure-model.md](./exposure-model.md) → [manifest.md](./manifest.md) → [openapi.md](./openapi.md) |
| **Partner sandbox testing** | [test-intent.md](./test-intent.md) → [structure-policy.md](./structure-policy.md) (public+test guard) |
| **CI compatibility gates** | [openapi.md](./openapi.md) → [compatibility.md](./compatibility.md) |
| **Hardening tenant boundaries** | [structure-policy.md](./structure-policy.md) → [exposure-model.md](./exposure-model.md) (auth + scopes) |
| **Pre-release health check** | [governance.md](./governance.md) (`plumbus verify`) + `plumbus api validate` (hard gates) |

## Agent instructions

Read these when you are an AI agent extending a Plumbus app that publishes a partner API. They live in the package ([`packages/api/instructions/`](../../packages/api/instructions/)) so they are available in `node_modules/@plumbus/api/instructions/` for agents working outside this monorepo:

- [`instructions/framework.md`](../../packages/api/instructions/framework.md) — package boundary, exports, critical rules
- [`instructions/expose-a-capability.md`](../../packages/api/instructions/expose-a-capability.md) — full exposure recipe
- [`instructions/manifest-and-cli.md`](../../packages/api/instructions/manifest-and-cli.md) — manifest, validation, OpenAPI, diff
- [`instructions/testing.md`](../../packages/api/instructions/testing.md) — test intent, idempotency, route tests

## When to reach for `@plumbus/api` vs. something else

| You want… | Reach for |
|---|---|
| App-internal routes for your own UI (`/api/{domain}/{kebab-name}`) | Default HTTP runtime in `@plumbus/core` |
| Typed client generation for your Next.js app | [`@plumbus/ui`](../ui/ui-generation.md) |
| Expose a capability to an AI agent over MCP | [`@plumbus/mcp`](../mcp/overview.md) |
| **Versioned, documented partner API with OpenAPI + diff + test fixtures** | **`@plumbus/api`** |

Use the partner API layer when external systems — payment processors, ERP integrations, reseller portals — need a stable, documented HTTP contract. If only your own frontend calls the backend, the default convention routes are enough. If only AI agents need access, use MCP instead.

## CLI

```bash
plumbus api validate   # manifest, policy, path params, fixtures, governance (requires @plumbus/api)
```

See [overview.md](./overview.md) for `generate openapi`, `generate docs`, `diff`, and `test-fixtures validate`.
