# Approvals and human tasks

Plan 02 Stage 4 primitives. They sit in the existing capability and flow pipeline — not a second engine.

## Action-risk vocabulary (F-09)

Single module: `ActionRiskTier` in `@plumbus/core`.

| Tier | Approval gate |
|------|----------------|
| `read-only` | No |
| `limited-reversible` | No |
| `consequential` | Yes — bound, unexpired approval required |

Review mandate reason is separate: `risk-tier` | `application-mandated`. Retired values (`read`, `routine-write`, `sensitive-write`, `analytical`, `reversible-change`) are rejected at `defineCapability`.

When Plan 01 R1 lands in Design, swap that one module. Callers keep the same names.

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

Use the existing Wait step with event `approval_pending` (`APPROVAL_PENDING_WAIT`). `createFlowEngine` already pauses on `waitEvent` and `resume`s when the event arrives. Decision outcomes (D-02-3 default): `approved`, `rejected`, `changes-requested`, plus system `expired`.

## Tenant tables

`human_task`, `approval_request`, and `approval_decision` are in `FRAMEWORK_TABLE_NAMES`. Shipped SQL is `packages/plumbus-core/migrations/durable-tenant/0001_plan02_human_task.sql` (v1 field subset of `human-task.schema.json`). Apply on dedicated `plumbus_plan02_*` harness DBs only. Do not apply to application tenant databases.

## Wiring

```
createApprovalService({ db: tenantDb })
createApprovalService({ store: createSqlApprovalStore({ db: () => plane.db }) })
createApprovalService({ store: createMemoryApprovalStore() }) // unit tests
```

`db` is an existing tenant data-plane handle (`PostgresJsDatabase`) or a function that returns one (`DataPlaneResolver` / per-request ctx). No second driver.

Host opt-in on `createServer({ approvals })` and `createWorkerPool({ approvals })`. Omitted: existing hosts boot unchanged. Tests may also pass `approvals` into `createExecutionContext`.

`authorizationProvider` is optional and host-supplied. The harness stub (`createAllowAllAuthorizationProvider`) is not installed by default. The consuming application supplies the real gate.
