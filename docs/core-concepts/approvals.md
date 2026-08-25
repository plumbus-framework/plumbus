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

The gate fails closed if the host did not wire an approval service. Matching uses capability identity + definition version + input digest. Expiry, digest mismatch, and authorization revalidation after wait all refuse the handler.

## Flow wait

Use the existing Wait step with event `approval_pending` (`APPROVAL_PENDING_WAIT`). `createFlowEngine` already pauses on `waitEvent` and `resume`s when the event arrives. Decision outcomes (default set): `approved`, `rejected`, `changes-requested`, plus system `expired`.

## Tenant tables

`human_task`, `approval_request`, and `approval_decision` are in `FRAMEWORK_TABLE_NAMES`. Shipped SQL is `packages/plumbus-core/migrations/durable-tenant/0001_human_task.sql` (v1 field subset of `human-task.schema.json`). Apply on dedicated `plumbus_durable_test_*` harness DBs only. Do not apply to application tenant databases.

## Wiring

```
createApprovalService({ db: tenantDb })
createApprovalService({ store: createSqlApprovalStore({ db: () => plane.db }) })
createApprovalService({ store: createMemoryApprovalStore() }) // unit tests
```

`db` is an existing tenant data-plane handle (`PostgresJsDatabase`) or a function that returns one (`DataPlaneResolver` / per-request ctx). No second driver.

Host opt-in on `createServer({ approvals })` and `createWorkerPool({ approvals })`. Omitted: existing hosts boot unchanged. Tests may also pass `approvals` into `createExecutionContext`.

`authorizationProvider` is optional and host-supplied. The harness stub (`createAllowAllAuthorizationProvider`) is not installed by default. The consuming application supplies the real gate.

## Governed model calls

`createPlumbusRuntime` exposes the same approval store. Review binds capability identity, definition version, and a digest of `governedReviewSubject(input, pin)` so a model or artifact-digest change needs a new review. See [AI integration — governed model calls](../ai/ai-integration.md#governed-model-calls).
