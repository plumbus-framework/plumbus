# @plumbus/api — Agent Instructions

This folder ships with the npm tarball. It is the entry point for AI coding agents working in a Plumbus app that has `@plumbus/api` installed. Read these files when exposing capabilities to partners, maintaining `api.yaml`, generating OpenAPI, or wiring partner route tests.

These files are **prescriptive** (do this, don't do that). For the core/partner API overview and install path, read `node_modules/@plumbus/core/instructions/api.md`. Stay in this folder for step-by-step recipes.

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. Package map, what core owns vs what `@plumbus/api` owns, critical rules. |
| [expose-a-capability.md](./expose-a-capability.md) | Marking capabilities with `exposeAs: ['api']` (queries and actions). |
| [manifest-and-cli.md](./manifest-and-cli.md) | `api.yaml`, validation, OpenAPI/docs generation, compatibility diff, CLI commands. |
| [testing.md](./testing.md) | Test intent, idempotency, fixture validation, route integration tests. |

Package quickstart: [../README.md](../README.md).

## Critical rules

- **Framework-first.** Partner HTTP is a projection of `defineCapability` handlers — never re-implement business logic in raw Fastify routes or ad-hoc controllers. Use `ctx.*` subsystems inside handlers.
- **`exposeAs: ['api']` is required.** There is no `api.expose` boolean. `kind: 'eventHandler'` capabilities cannot be API-exposed.
- **`api.auth.scopes` are enforced at runtime** (union with `access.scopes` when both are set). Missing scopes return `403 missing_scope`.
- **Path parameters must map to input fields.** `{refundId}` in the route must exist on the capability `input` schema.
- **Default idempotency store is in-memory.** Production multi-instance deployments need a durable `idempotencyStore` with TTL.
- **`plumbus generate` OpenAPI ≠ partner OpenAPI.** Use `plumbus api generate openapi` for the canonical partner contract.
- **Public capabilities + test intent is forbidden.** `plumbus api validate` flags `policy.public-test-forbidden` when `access.public: true` enables test fixtures.
- **`plumbus api validate` governance is advisory by default.** Hard findings (manifest/policy/path/fixtures) exit `1`; governance signals do not unless you pass `--fail-on-governance`. See [manifest-and-cli.md](./manifest-and-cli.md).
