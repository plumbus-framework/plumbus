# Approvals and human tasks

Approval and human-task primitives. They sit in the existing capability and flow pipeline — not a second engine.

## Action-risk vocabulary

Single module: `ActionRiskTier` in `@plumbus/core`.

| Tier | Approval gate |
|------|----------------|
| `analytical` | No |
| `limited-reversible` | No |
| `consequential` | Yes — bound, unexpired approval required |
| `prohibited` | Never runs — refused outright, cannot be proposed for approval, cannot be exposed |

Review mandate reason is separate: `risk-tier` | `application-mandated`. Retired values (`read`, `read-only`, `routine-write`, `sensitive-write`, `reversible-change`) are rejected at `defineCapability`.

`prohibited` is normative: the gate blocks it with code `prohibited-capability` before any approval lookup (an approval must not make a prohibited action permissible), `requestApproval` rejects `riskClass: 'prohibited'`, and `defineCapability` refuses `exposeAs` on a prohibited capability so it is never listed as an MCP tool or API route.

If a host contract later standardizes different tier names, swap that one module. Callers keep the same names.

## Capability pipeline

`executeCapability` order:

1. Validate input
2. Evaluate access
3. **Approval gate** (consequential only)
4. Handler
5. Validate output
6. Audit

The gate fails closed if the host did not wire an approval service. Matching uses tenant + flow execution + capability identity + definition version + input digest:

- **Tenant** — the gate looks up `ctx.auth.tenantId` (`null` when untenanted). An approval requested for tenant A never satisfies a gate running for tenant B, even on a shared `ApprovalService`.
- **Execution** — the gate looks up `ctx.flowId`. An approval requested with `executionId` is consumable only by that flow execution; one requested without an `executionId` is consumable only outside a flow.

Expiry (checked at consumption time — an approved request past `expiresAt` is `expired`, never `approved`), digest mismatch, and authorization revalidation after wait all refuse the handler.

`requestApproval` requires `tenantId` (the requesting tenant, or `null` for an untenanted app). Pass the flow `executionId` when the approval is for a flow step.

## Flow wait

Use the existing Wait step with event `approval_pending` (`APPROVAL_PENDING_WAIT`). `createFlowEngine` already pauses on `waitEvent` and `resume`s when the event arrives. Decision outcomes (default set): `approved`, `rejected`, `changes-requested`; system terminal states include `expired`, `invalidated`, and `cancelled`.

An `approval-outcome` step reads the latest request for its own tenant and execution (`findByExecutionId({ tenantId, executionId })`). An approved request whose `expiresAt` has passed when the step runs routes as `expired`, which has no outcome route, so the step fails instead of taking the `approved` branch.

## Deciding

`approvals.decide({ requestId, outcome, auth })` records `approved`, `rejected`, or `changes-requested` (any other outcome is refused). It requires an authenticated human actor and runs **every** decision type through the service's `authorization` provider, not only approvals.

Authorization fails closed: `createApprovalService` without `authorization` refuses every `decide` and `cancel`. Pass the application's real provider; `createAllowAllAuthorizationProvider()` is the explicit opt-out for tests and single-operator tools.

A decision applies only while the request is still `pending`: the store updates the row with a compare-and-set on state (`UPDATE … WHERE state = 'pending'`) and writes the `approval_decision` row in the same transaction. When two approvers race, exactly one decision is stored; the other call throws `ApprovalDecisionConflictError` (`code: 'approval-decision-conflict'`, `currentState` = the winner's state) and writes nothing. Expiry and material-change invalidation use the same compare-and-set, so they never overwrite a decision that landed first.

## Request cancellation

`approvals.cancel({ requestId, auth, reason })` withdraws a pending request. It requires an
authenticated human actor, revalidates that actor through the configured authorization provider,
records the actor and a 1–500 character reason, and atomically moves linked open or claimed human
tasks to `cancelled`. It creates no `approval_decision`: cancellation is withdrawal by an
authorized actor, not an approver outcome. Missing, expired, decided, invalidated, or already
cancelled requests refuse without changing state. Applications remain responsible for expressing
their actor rule (for example, “only the stored originator may withdraw”) in the authorization
provider or an application capability before calling the primitive.

## Tenant tables

`human_task`, `approval_request`, and `approval_decision` are in `FRAMEWORK_TABLE_NAMES`. Shipped SQL starts at `packages/plumbus-core/migrations/durable-tenant/0001_human_task.sql`; `0002_approval_cancellation.sql` adds cancellation actor/reason evidence; `0005_approval_tenant_binding.sql` adds `approval_request.tenant_id` and the `(tenant_id, execution_id)` index. Rows written before 0005 have `tenant_id = NULL` and therefore match only untenanted lookups. `0006_approval_live_index.sql` adds `approval_request_live_idx` on `(tenant_id, execution_id, capability_id) WHERE state IN ('pending', 'approved')`, built `CONCURRENTLY` in a [`-- plumbus:no-transaction`](../sdk-reference/data-layer.md#non-transactional-migrations-create-index-concurrently) migration. Apply on dedicated `plumbus_durable_test_*` harness DBs only. Do not apply to application tenant databases: an application gets the same index through its own generated migrations — the next `plumbus migrate generate` after upgrading emits `CREATE INDEX IF NOT EXISTS "approval_request_live_idx" ...`. On a large `approval_request` table, edit that generated file into a no-transaction migration with `CREATE INDEX CONCURRENTLY` before applying it to a live database.

## Store reads (core 0.9.0-beta.13+)

The approval service reads `approval_request` through indexes, scoped to what each call needs,
never the whole table:

| service call | store read |
| --- | --- |
| `requestApproval`, `invalidateOnMaterialChange` (material-change invalidation) | live (`pending` / `approved`) requests of the same tenant, execution and capability — `approval_request_live_idx` |
| `findMatchingApproval` (the capability gate) | the same tenant + execution + capability, definition version and input digest — `approval_request_binding_idx` |
| `findConflictingApproval` (the capability gate) | live requests of the same tenant, execution and capability — `approval_request_live_idx` |
| `findByExecutionId` | the newest request of the tenant + execution — `approval_request_subject_idx` |

Approvals that are past `expiresAt` among those rows are expired in **one** `UPDATE` per call
(`expireRequests`), only while still `pending` or `approved`; a request another writer settled
first keeps the winner's state.

The store methods behind this are part of `ApprovalStore` (exported from `@plumbus/core` with
`ApprovalRequestQuery`, `ApprovalRequestPage` and `MAX_APPROVAL_PAGE_SIZE`):

- `findRequests(query)` — `tenantId`, `executionId`, `capabilityId`, `definitionVersion`,
  `inputDigest`, `states`, `limit` (1–1000). A field left out matches anything; `null` for
  `tenantId` / `executionId` matches only rows stored without one. Newest first.
- `listAllRequests({ limit, after })` — every request, paged by id (keyset on the primary key,
  1–1000 per page; pass the previous page's `next` as `after`). For callers that truly need
  everything: exports, operator lists.
- `expireRequests({ approvalRequestIds, now })` — the one-statement expiry above.

`listRequests()` is kept and still returns every row in one read; it is deprecated because on
the SQL store that is a full table load. The three new methods are optional on the interface:
a host-written store without them keeps working, and the service then falls back to
`listRequests()` and filters in memory (the old cost). Application code that called
`store.listRequests()` and filtered in JavaScript should call `findRequests` with the same
predicate instead — for example `findRequests({ tenantId, executionId })` for one execution's
approvals.

## Wiring

```
createApprovalService({ db: tenantDb, authorization: hostApprovalAuthorization })
createApprovalService({ store: createSqlApprovalStore({ db: () => plane.db }), authorization })
createApprovalService({
  store: createMemoryApprovalStore(),
  authorization: createAllowAllAuthorizationProvider(), // unit tests: explicit opt-out
})
```

`db` is an existing tenant data-plane handle (`PostgresJsDatabase`) or a function that returns one (`DataPlaneResolver` / per-request ctx). No second driver.

Host opt-in on `createServer({ approvals })` and `createWorkerPool({ approvals })`. Omitted: existing hosts boot unchanged. Tests may also pass `approvals` into `createExecutionContext`.

Two separate host gates:

- `createApprovalService({ authorization })` — who may decide or cancel a request. Required for any decision (see [Deciding](#deciding)).
- `createServer({ authorizationProvider })` / execution-context `authorizationProvider` — optional revalidation of the caller when the gate consumes an approval after a wait.

Neither installs `createAllowAllAuthorizationProvider` by default. The consuming application supplies the real gate.

## Governed model calls

`createPlumbusRuntime` exposes the same approval store. Review binds capability identity, definition version, and a digest of `governedReviewSubject(input, pin)` so a model or artifact-digest change needs a new review. See [AI integration — governed model calls](../ai/ai-integration.md#governed-model-calls).
