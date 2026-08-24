# Dispatch and execution-state protocol (Protocol A)

**Status:** Adopted default with an executable in-memory model  
**Binding default:** Protocol A — tenant-DB-authoritative state + spine outbox with idempotent re-dispatch

This is the tracked copy of the dispatch/state protocol. The working copy also lives at
`design/dispatch-state-protocol.md` (gitignored nested design tree).

The live flow engine still stores executions and leases in one database. The durable core
evolves that engine to this protocol. It does not add a second workflow engine.

## Authority model

| Store | Role | Recovery unit? |
|-------|------|----------------|
| **Tenant DB** (`core_plumbus`) | Authoritative for all private execution state, dispatch-outbox rows, event outbox, idempotency keys | **Yes** — tenant backup/restore is the execution-state recovery unit |
| **Spine DB** | Opaque dispatch wake-up hints, tenant routing refs, provisioning/lifecycle metadata | **No** — spine dispatch rows are reconstructible scheduling hints |

Spine rows carry only opaque references (`executionId`, `tenantExecutionStateRefId`, expected
`revision`, `tenantEpoch`). No private payload, no step inputs/outputs, no domain writes.

## Persist-before-ack

Durable acceptance is a tenant commit, then an ack:

1. In one tenant transaction: CAS `execution_state.revision` and insert `dispatch_outbox`.
2. Return ack to the inbound dispatcher only after that transaction commits.
3. Publish the spine hint after commit. A crash between (2) and (3) is repaired by the tenant sweep.

A crash *inside* the tenant transaction rolls back both the state row and the outbox row. The
caller may retry; accept is idempotent on `idempotencyKey`.

## Opaque-reference dispatch flow

```
┌─────────────┐     same txn      ┌──────────────────┐
│ Worker /    │ ────────────────► │ Tenant DB        │
│ Flow step   │   revision CAS +  │ execution_state  │
└─────────────┘   dispatch_outbox └────────┬─────────┘
                                           │ after commit
                                           ▼
                                  ┌──────────────────┐
                                  │ Per-tenant pump  │
                                  │ (post-commit)    │
                                  └────────┬─────────┘
                                           ▼
                                  ┌──────────────────┐
                                  │ Spine DB         │
                                  │ opaque_dispatch  │
                                  └────────┬─────────┘
                                           │ SKIP LOCKED claim
                                           ▼
                                  ┌──────────────────┐
                                  │ Worker           │
                                  │ re-read tenant   │
                                  │ truth → execute  │
                                  │ or no-op ack     │
                                  └──────────────────┘
```

### Transition sequence (happy path)

1. **Commit transition (tenant DB, single transaction).**
   - CAS-update `execution_state.revision`.
   - Append/update step, wait, or terminal sub-state as required.
   - Insert or update `dispatch_outbox` row: `{ outboxId, executionId, stateRefId, expectedRevision, tenantEpoch, publishedAt: null }`.
   - Append domain writes and `event_outbox` rows in the same transaction when applicable.

2. **Publish dispatch hint (post-commit, idempotent).**
   - Per-tenant pump reads unacknowledged outbox rows.
   - Upsert spine `OpaqueDispatchRecord` keyed by `(tenantRouteId, executionId, expectedRevision)`.
   - Mark outbox `spineRowId` / `publishedAt` when spine write succeeds.

3. **Claim spine row (worker liveness).**
   - `SELECT … FOR UPDATE SKIP LOCKED` on the spine dispatch table (in-memory claim skips an unexpired lease).
   - Acquire lease with expiry; lease lives on spine only.

4. **Reconcile and execute (tenant truth).**
   - Resolve tenant route via `DataPlaneResolver`.
   - Load execution state; compare `revision` and `tenantEpoch`.
   - **Stale dispatch:** revision advanced or epoch mismatch → ack spine row, no side effects.
   - **Current dispatch:** execute step under immutable context → return to step 1 on mutation.

5. **Ack spine row.**
   - After successful tenant commit (or deterministic no-op), mark spine row acknowledged.
   - Mark tenant outbox row acknowledged in a follow-up tenant transaction.

Duplicate or delayed spine delivery is safe: step 4 no-ops when revision has advanced. Lost spine
rows are repaired by the tenant-side orphan sweep.

## Tenant-local durable state placement

| Artifact | Purpose |
|----------|---------|
| `execution_state` | ExecutionState v1 subset with monotonic `revision` |
| `step_execution` / `wait_state` / `terminal_state` | Step lifecycle (v1 field subset) |
| `dispatch_outbox` | Commit-coupled spine publication queue |
| `event_outbox` | Commit-coupled cross-boundary events (existing table; not moved this milestone) |
| `idempotency` | Protected side-effect deduplication |

v1 omits contract fields that cannot be populated honestly: per-step
`authorizationDecisionRefId`, required `domainOutcomeId` on infrastructure-failure terminals,
budget/evidence/provenance refs, human-task and approval refs. These are documented
relaxations, not silent omissions at conformance time.

## Per-tenant epoch / generation guard

Each tenant carries a monotonic `tenantEpoch`:

- Incremented on tenant restore, route-epoch bump, or other control-plane events that invalidate
  in-flight dispatch assumptions.
- Recorded on every `execution_state` row and every `dispatch_outbox` / spine dispatch row.
- Workers fail closed when spine `tenantEpoch` ≠ tenant `execution_state.tenantEpoch`.
- Spine-side orphan sweep treats epoch-mismatched unacked rows as dangling → ack without re-dispatch.

## Orphan recovery sweeps

### Sweep 1 — Tenant-side (lost spine publication)

**Trigger:** outbox row with `publishedAt IS NULL` or `spineAckedAt IS NULL` older than `T₁`.

1. Re-read execution state; if terminal, mark outbox complete without republishing.
2. Else idempotently upsert spine dispatch row from the outbox payload.
3. Never republish rows whose `tenantEpoch` ≠ current tenant epoch (mark superseded).

### Sweep 2 — Spine-side (dangling dispatch)

**Trigger:** spine row unacked, lease expired, older than `T₂`.

1. Load tenant execution state via opaque ref.
2. No live state (missing row, terminal, or epoch mismatch) → ack spine row, no worker dispatch.
3. Live state, revision behind spine `expectedRevision` → leave for worker or tenant sweep.
4. Live state, revision matches → optionally nudge tenant pump; do not mutate tenant state from spine.

## Crash-matrix simulation

Executable model: `packages/plumbus-core/src/testing/crash-matrix-simulation.ts`  
Implementation it drives: `packages/plumbus-core/src/durable/`

Crash points: `before-tenant-commit`, `after-tenant-commit-before-publish`,
`after-spine-upsert-before-outbox-mark`, `after-claim-before-tenant-reread`,
`after-tenant-commit-before-spine-ack`, `after-spine-ack-before-outbox-ack`,
`during-tenant-sweep-after-republish`, `during-spine-sweep-after-ack`.

Property checks after recovery:

1. **No accepted work lost** — a committed tenant transition is never rolled back by crash or duplicate dispatch.
2. **No protected side effect duplicated** — idempotency keys + revision CAS.
3. **Eventual progress** — sweeps plus worker retry complete live executions under a stable epoch.

## Candidate protocols

| Protocol | Verdict |
|----------|---------|
| **A — tenant-authoritative + spine outbox** | **Default.** Safe duplicates by construction. |
| B — spine-authoritative two-phase ack | Rejected default: dual authority on every crash window. |
| C — per-tenant polling workers | Costed fallback; foreclosed as the initial profile by the authority split above. |

## Implementation note (2026-08-20)

Source (not yet in published `dist`): `createFlowEngine({ spineDispatch })` claims
`opaque_dispatch` with `FOR UPDATE SKIP LOCKED`, then loads tenant
`execution_state` / `flow_executions` through `DataPlaneResolver`. Worker
bootstrap passes that config when a resolver is set. `createOutboxDispatcher`
pumps each listed tenant's `event_outbox` and `dispatch_outbox` (same
dispatcher, not a second bus). `createTransactionRunner({ durableDispatch })`
writes `dispatch_outbox` in the tenant transaction. Event worker and
scheduler resolve per tenant when `DataPlaneResolver` is set. Shipped SQL:
`packages/plumbus-core/migrations/`. Local harness: `src/durable/harness.ts`
(`plumbus_durable_test_*` databases only). Crash-matrix CI job: `protocol-a` in
`.github/workflows/test.yml`.

## Acceptance

- [x] Protocol document (this file + `design/dispatch-state-protocol.md`).
- [x] Executable crash-matrix simulation with property checks (in-memory; CI job `protocol-a` in `.github/workflows/test.yml`).
