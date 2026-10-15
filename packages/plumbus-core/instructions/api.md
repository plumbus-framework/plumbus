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

Install the runtime when serving partners: `pnpm add @plumbus/api@plumbus-next` (optional peer of `@plumbus/core`, which declares `@plumbus/api` `>=0.4.0-beta.0 <0.5.0` in the core 0.9 beta family; npm `latest` is `0.3.x` in the core 0.8 stabilization family).

## Declared idempotency on the `/api` surface

A capability that declares `api: { idempotency: { required: true, header: 'Idempotency-Key', ttl?: '24h' } }`
is served by the route generator only with that header present. The key is scoped
`operationId:tenant:user:key`; the same key with the same input replays the first answer, the
same key with different input is refused with `422` and from another principal with `409`
(both `conflict`, `metadata.reason: 'idempotency-conflict'`; before core 0.9.0-beta.1 a
different input was `409` too), a retry while another request holds the key is `409` with
`Retry-After` (`metadata.reason: 'idempotency-in-progress'`, database store), a missing header is `validation`
(`metadata.reason: 'idempotency-key-required'`), and a failed execution releases the key so a
retry executes again. Authorization is evaluated before the header is looked at, so a refused
caller is answered by the executor as always. Reads (`GET`) are never keyed. The payload
fingerprint (`hashPayload`) refuses a body nested deeper than `MAX_PAYLOAD_DEPTH` (64 levels)
with `validation` (`metadata.reason: 'payload-too-deep'`) — a pathological body can never take
the hasher down with a `RangeError`.

The store is `RouteGeneratorConfig.idempotencyStore` (`IdempotencyStore`, from
`createServer({ idempotencyStore })` or `export const idempotencyStore` in `app/server.ts` for
`plumbus dev` / `start`); when unset every route registered with one config shares one
`createInMemoryIdempotencyStore()` — correct within a process, lost on restart, and a retry
that reaches another copy runs again. `createServer` warns in `production` and `staging` when
idempotent routes use an in-memory store. The store contract (`claim` / `complete` /
`completeInTransaction` / `abort`, `hashPayload`, `parseIdempotencyTtl`,
`buildIdempotencyStoreKey`, `executeIdempotently`) is exported from `@plumbus/core` and the
in-memory store is re-exported by `@plumbus/api`, whose routes use the server's store unless
given their own.

### Database store (more than one process)

```typescript
// app/server.ts
import { createDatabaseIdempotencyStore } from "@plumbus/core";

export const idempotencyStore = createDatabaseIdempotencyStore(); // leaseMs 60 s, default ttl 24 h
```

Records live in `request_idempotency` on the database the request's capability writes to: the
spine (unqualified) for control-plane requests, `<framework schema>.request_idempotency`
(`core_plumbus` by default, `tenantSchema` option) on the tenant plane under
`requestDataPlane: 'resolved'`. Create the table on every plane: the shipped migrations
`migrations/spine/0001_request_idempotency.sql` and
`migrations/durable-tenant/0003_request_idempotency.sql`, or `requestIdempotencyDdl()` /
`requestIdempotencyDdl('core_plumbus')` copied into your own migration stream.

- **Key:** sha256 of `operationId:tenant:user:key`; also stored: principal id, tenant scope
  (`spine` without a tenant), and a sha256 of the canonical request (input + caller authority).
- **Claim:** one committed statement inserts `in-progress` with a lease (`leaseMs`, default
  60 s). A retry while the lease is live gets `409` + `Retry-After`; a retry after the lease
  lapsed with no completion (the claiming process died, or its transaction rolled back) runs
  the request again.
- **Completion:** for a transactional capability (actions and event handlers, unless
  `transactional: false`, AI or external effects, or the outbox kill switch) it is written
  inside the capability's business transaction (`executeCapability(…, { beforeCommit })`), so
  the business effect and the stored answer commit together or not at all. A run whose claim
  was taken over by a retry (it outlived its lease) cannot record its completion: its
  transaction rolls back and it answers `409` (`idempotency-claim-lost`). Make `leaseMs` longer
  than the slowest idempotent capability.
- **Gap — capabilities without a transaction:** the completion is written after the handler
  returned. A crash between the handler's effects and that write leaves the claim to lapse, and
  a retry after the lease runs the capability again. External effects (and these capabilities)
  must carry their own idempotency keys.
- **Failure:** a failed or throwing run deletes its claim, so the caller may retry at once.
- **TTL:** the route's `ttl` (default 24 h). Each store sweeps a database at most once an hour
  as it claims on it; `sweepExpiredIdempotencyRecords(db, { schemaName })` is exported for a
  scheduled job.
