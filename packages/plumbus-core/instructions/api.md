# Partner API — Core surface

Plumbus capabilities can be exposed to partners on versioned HTTP routes. **Contract and CLI** live in `@plumbus/core`; **runtime server, manifest tooling, OpenAPI export, and test intent** live in `@plumbus/api`.

## Where to read

| Layer | Location |
|-------|----------|
| **Agent recipes (start here when `@plumbus/api` is installed)** | `node_modules/@plumbus/api/instructions/README.md` |
| **Conceptual docs** | `docs/api/` in the monorepo — [overview](../../../docs/api/overview.md), [exposure model](../../../docs/api/exposure-model.md), [manifest](../../../docs/api/manifest.md), [OpenAPI](../../../docs/api/openapi.md) |

## Core responsibilities

- **`exposeAs: ['api']`** on `defineCapability` — opt-in per capability.
- **`kind: 'query'` and `kind: 'action'`** — eligible for partner routes. **`kind: 'eventHandler'`** and **`kind: 'job'`** cannot be API-exposed.
- **`plumbus api validate` / `generate` / `diff` / `test-fixtures validate`** — CLI entry points; dynamic import of `@plumbus/api`.
- **`registerApiRoutes()`** — mount partner routes at app bootstrap (requires `@plumbus/api` install).

`plumbus api validate` exits `1` only on hard findings by default; pass `--fail-on-governance` to also fail on advisory API governance signals. Details: `node_modules/@plumbus/api/instructions/manifest-and-cli.md`.

Install the runtime when serving partners: `pnpm add @plumbus/api` (optional peer of `@plumbus/core`, version-locked `0.1.x`).

## Declared idempotency on the `/api` surface

A capability that declares `api: { idempotency: { required: true, header: 'Idempotency-Key', ttl?: '24h' } }`
is served by the route generator only with that header present. The key is scoped
`operationId:tenant:user:key`; the same key with the same input replays the first answer, the
same key with different input or from another principal is refused with `conflict`
(`metadata.reason: 'idempotency-conflict'`), a missing header is `validation`
(`metadata.reason: 'idempotency-key-required'`), and a failed execution releases the key so a
retry executes again. Authorization is evaluated before the header is looked at, so a refused
caller is answered by the executor as always. Reads (`GET`) are never keyed.

The store is `RouteGeneratorConfig.idempotencyStore` (`IdempotencyStore`, from
`createServer({ idempotencyStore })`); when unset every route registered with one config
shares one `createInMemoryIdempotencyStore()` — correct within a process, lost on restart.
A deployment that needs replay protection across instances supplies a shared store. The store
contract (`claim` / `complete` / `abort`, `hashPayload`, `parseIdempotencyTtl`,
`buildIdempotencyStoreKey`) is exported from `@plumbus/core` and re-exported by `@plumbus/api`.
