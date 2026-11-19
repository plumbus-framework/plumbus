# Execution Lifecycle

This document traces the complete lifecycle of a request through the Plumbus framework.

## Capability Execution Flow

Static access policy (roles, scopes, tenant and principal) is checked before the input schema is parsed. A caller denied by that policy receives a forbidden response for both well-formed and malformed input; the audit outcome is `denied`, without schema issues. After static admission, input is validated and transformed, and the optional input-aware `authorize(ctx, input)` hook receives that parsed value. Approval gates and handler execution follow. HTTP queued jobs also check static access before their enqueue-time schema parse. See [security model](../security/security-model.md).


```
                            ┌──────────────────┐
                            │   HTTP Request    │
                            │ POST /api/users/  │
                            │   create-user     │
                            └────────┬─────────┘
                                     │
                            ┌────────▼─────────┐
                       ┌────│  Route Generator  │
                       │    │  (auto-matched)   │
                       │    └────────┬─────────┘
                       │             │
                 404   │    ┌────────▼─────────┐
                 Not   │    │ Parse Auth Token  │
                 Found │    │ (JWT adapter)     │
                       │    └────────┬─────────┘
                       │             │
                       │    ┌────────▼─────────┐
                       │    │ Build AuthContext  │
                       │    │ userId, roles,    │
                       │    │ scopes, tenantId  │
                       │    └────────┬─────────┘
                       │             │
                       │    ┌────────▼─────────┐
                       │    │ Create Execution  │
                       │    │ Context (ctx)     │
                       │    └────────┬─────────┘
                       │             │
                       │    ┌────────▼─────────┐     ┌───────────┐
                       │    │ Evaluate Access   │────▶│  403      │
                       │    │ (access policy)   │ no  │ Forbidden │
                       │    └────────┬─────────┘     └───────────┘
                       │             │ ok
                       │    ┌────────▼─────────┐     ┌───────────┐
                       │    │ Validate Input    │────▶│  400      │
                       │    │ (Zod schema)      │ err │ Validation│
                       │    └────────┬─────────┘     └───────────┘
                       │             │ yes
                       │    ┌────────▼─────────┐     ┌───────────┐
                       │    │ Execute Handler   │────▶│  500/4xx  │
                       │    │ handler(ctx,input)│ err │ Error     │
                       │    └────────┬─────────┘     └───────────┘
                       │             │ ok
                       │    ┌────────▼─────────┐
                       │    │ Validate Output   │
                       │    │ (Zod schema)      │
                       │    └────────┬─────────┘
                       │             │
                       │    ┌────────▼─────────┐
                       │    │ Record Audit Entry│
                       │    └────────┬─────────┘
                       │             │
                       │    ┌────────▼─────────┐
                       │    │ Return Response   │
                       │    │ 200 OK            │
                       │    └──────────────────┘
                       │
                       │         Async (after response)
                       │    ┌──────────────────┐
                       └───▶│ Outbox Dispatcher │
                            │ polls + publishes │
                            │ events to queue   │
                            └──────────────────┘
```

## Flow Execution Lifecycle

For large binary or text payloads, keep flow `input` and `state` small and store bytes in an app entity — see [Passing large payloads by reference](../core-concepts/flows.md#passing-large-payloads-by-reference).

```
┌─────────────┐
│   Trigger   │
│ (event,     │
│  schedule,  │
│  manual)    │
└──────┬──────┘
       │
       ▼
┌──────────────┐     ┌──────────────────────────────────────┐
│ Flow Engine  │     │         State Machine                 │
│              │     │                                        │
│  Initialize  │────▶│  created ──▶ running ──▶ completed   │
│  execution   │     │              │    │                    │
│              │     │              │    ├──▶ failed          │
│              │     │              │    │                    │
│              │     │              │    ├──▶ cancelled     │
│              │     │              │    │                    │
│              │     │              │    └──▶ waiting         │
│              │     │                       (for event/delay)│
│              │     └──────────────────────────────────────┘
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│                    Step Execution                         │
│                                                          │
│  For each step in flow.steps:                           │
│                                                          │
│  ┌─────────────────┐                                    │
│  │ capability step  │  → Execute capability via engine   │
│  └─────────────────┘                                    │
│  ┌─────────────────┐                                    │
│  │ conditional step │  → Evaluate `if` expression        │
│  │                  │  → Branch to `then` or `else`      │
│  └─────────────────┘                                    │
│  ┌─────────────────┐                                    │
│  │ parallel step    │  → Promise.allSettled(branches)    │
│  │                  │  → Concurrent execution            │
│  └─────────────────┘                                    │
│  ┌─────────────────┐                                    │
│  │ wait step        │  → Pause until event received      │
│  └─────────────────┘                                    │
│  ┌─────────────────┐                                    │
│  │ delay step       │  → Pause for duration              │
│  └─────────────────┘                                    │
│  ┌─────────────────┐                                    │
│  │ eventEmit step   │  → Emit event via ctx.events       │
│  └─────────────────┘                                    │
│                                                          │
│  Each step produces a StepHistoryEntry:                  │
│  { step, status, startedAt, completedAt?, error? }        │
└──────────────────────────────────────────────────────────┘
```

Capability steps reference targets by **canonical name** (`orders.validateOrder`). Step auth comes from `flow_executions.auth_snapshot_json` — not worker `system` roles on user-triggered flows. Job capabilities cannot run synchronously inside a step.

## Transactional outbox (default ON)

For `action` and `eventHandler` capabilities, handler execution, output validation, `ctx.data.*` mutations, and `ctx.events.emit()` outbox inserts run in **one database transaction**. On handler failure or invalid output, entity writes and outbox rows roll back together. Auto-excluded: `kind: 'job'`, `effects.ai: true`, `effects.external` (non-empty), and `query`.

Opt out globally with `execution.transactionalOutbox: false` (or `PLUMBUS_TRANSACTIONAL_OUTBOX=false`), or per capability with `transactional: false`. See [Upgrading for contract alignment](../upgrading-contract-alignment.md#1-transactional-outbox-default-on-a1).

Audit inside the transaction uses the transaction's connection (core 0.9.0-beta.5+): with the default audit service, the scope carries a transaction-bound audit service (`TransactionScope.audit`) that the handler sees as `ctx.audit` and that tx-scoped data and events use. A transaction therefore holds exactly one pool connection, however many rows it audits. On rollback, `failure`/`denied` records are re-written through the outer database after the connection is released; `success` records are discarded with the work. The capability's own success row is written after commit on the outer database, as before. A custom audit service keeps writing outside the transaction.

### When the transaction opens

The executor asks the runner for a **lazily opened** transaction (`execution.transactionBegin:
'lazy'`, the default; a capability's `transactional: 'lazy' | 'eager'` overrides the host). Until
something needs it, no `BEGIN` is sent and no pool connection is held. What opens it:

| Handler call | Why it needs the transaction |
|--------------|------------------------------|
| `ctx.data.<E>.create` / `createMany` / `update` / `updateWhere` / `delete` | the write and its mutation audit row commit with the rest |
| `ctx.events.emit` / `emitMany` (non-empty) | the `event_outbox` row commits with the data |
| `ctx.flows.start` (durable start target) | the `flow_start_intents` row is written in it; the start runs after commit |
| `ctx.jobs.enqueue` (built-in dispatcher) | the job intent row is written in it; publication runs after commit |
| `scope.persistAcceptance` / `enqueueDispatch` (durable dispatch) | `execution_state` / `dispatch_outbox` rows |
| `scope.acquire()` (framework-internal; raw SQL on the transaction) | returns the handle |

Reads (`findById`, `findMany`, `findManyFields`, `findPage`, `count`, `exists`, `aggregate`) made
before that run on the pool; from the moment the transaction starts opening, they run in it.
`ctx.flows.wake` stays post-commit; `resume` / `cancel` / `terminate` / `status` are unchanged.
`ctx.audit.record` with the default audit service: a `success` record made before the open is held
and written into the transaction when it opens, through the outer writer when the handler returns
without opening one, and dropped when the handler throws; `failure`/`denied` records are written at
once. Nested capabilities that share the scope share the same lazy transaction. The HTTP
idempotency completion (`beforeCommit`) is written in the transaction when it was opened, and after
the call when it was not. When the handler returns, an opened transaction commits (and deferred
post-commit work runs); when it throws or its output is invalid, it rolls back.

**Isolation.** Reads before the first write no longer share the transaction. Under `READ
COMMITTED` (PostgreSQL's default, and what the framework uses: it sets no isolation level) every
statement takes its own snapshot inside or outside a transaction, a plain `SELECT` takes no row
lock, and the repository has no `FOR UPDATE`, so nothing a handler can observe through `ctx.data`
changes. It differs when the database or role defaults to `REPEATABLE READ` or `SERIALIZABLE` (the
early read is outside the transaction's snapshot and serializability checks), and for code that
used the internal `transactionScope.db` handle directly (`undefined` until the transaction opens;
`acquire()` opens it). Those capabilities set `transactional: 'eager'`.

**Bounded wait.** `execution.transactionAcquireTimeoutMs` (`PLUMBUS_TRANSACTION_ACQUIRE_TIMEOUT_MS`,
default 10 000, `0` = no limit) bounds the wait for the pool connection `BEGIN` needs. Past it the
open fails with `DataPoolAcquireTimeoutError` (`internal`, `httpStatus: 503`, `retryAfter: 1`,
`reason: 'pool-acquire-timeout'`), the handler sees the error at the call that needed the
transaction, and nothing it wrote in the transaction exists. When the connection frees later, the
abandoned `BEGIN` is rolled back at once. The failure audit row of such a refusal is written in the
background, so the 503 does not wait for the same pool. The bound applies to opening a capability
transaction only: other queries on a saturated pool (reads, audit inserts, the idempotency claim)
still wait in postgres.js's queue, which has no time limit; set
`DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` so an idle transaction cannot hold a connection forever.

### Nested capability invocation

When a capability handler calls `ctx.capabilities.invoke`, the framework runs the callee through the same pipeline (access, validation, audit) with inherited auth and correlation metadata. Targets must be listed in the caller's `effects.capabilities`. Undeclared calls, cycles, missing targets, and synchronous job invokes return `dependencyViolation`. Handler-visible `ctx.__runtime` does not expose internal invokers — only `ctx.capabilities.invoke` is supported in application code. (`stripHandlerRuntime` makes one framework-internal exception, keyed on the canonical name `chat.chatConfirmAction`, so that confirming a pending chat action can re-enter the capability pipeline; application capabilities cannot request it.) Prefer flows for multi-step orchestration; use invoke when a callee's result is needed in the same execution path.

## Event Processing Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Handler     │     │   Outbox     │     │  Dispatcher  │
│              │     │   Table      │     │              │
│ ctx.events   │────▶│ (PostgreSQL) │────▶│  Poll every  │
│   .emit()    │     │              │     │  1s (config) │
│              │     │ ┌──────────┐ │     │              │
│ (writes to   │     │ │ eventType│ │     │  Mark as     │
│  event_outbox│     │ │ payload  │ │     │  dispatched  │
│  on emit)    │     │ │ tenantId │ │     │              │
│              │     │ │ status   │ │     └──────┬───────┘
└──────────────┘     │ └──────────┘ │            │
                     └──────────────┘            │
                                                 ▼
                                       ┌──────────────────┐
                                       │    Event Queue    │
                                       │  (Redis/Memory)   │
                                       └────────┬─────────┘
                                                │
                                       ┌────────▼─────────┐
                                       │   Event Worker    │
                                       │                   │
                                       │ ┌───────────────┐ │
                                       │ │ Idempotency   │ │
                                       │ │ Check         │ │
                                       │ └───────┬───────┘ │
                                       │         │         │
                                       │ ┌───────▼───────┐ │
                                       │ │ Consumer      │ │
                                       │ │ Registry      │ │
                                       │ │ Lookup        │ │
                                       │ └───────┬───────┘ │
                                       │         │         │
                                       │ ┌───────▼───────┐ │
                                       │ │ Execute       │ │
                                       │ │ Consumer(s)   │ │
                                       │ └───────┬───────┘ │
                                       │         │         │
                                       │ ┌───────▼───────┐ │
                                       │ │ On failure:   │ │
                                       │ │ Dead Letter   │ │
                                       │ └───────────────┘ │
                                       └───────────────────┘
```

## AI Request Lifecycle

```
┌─────────────────┐
│ ctx.ai.generate │
│ ({prompt, input})│
└────────┬────────┘
         │
┌────────▼────────┐
│  Prompt Registry │
│  Lookup prompt   │
│  definition      │
└────────┬────────┘
         │
┌────────▼────────┐     ┌──────────────┐
│ Security Check  │────▶│ Warn / redact│
│                 │     │ classified   │
│ - PII detection │     │ fields, then │
│ - Scope check   │     │ proceed      │
└────────┬────────┘     └──────────────┘
         │ pass
┌────────▼────────┐
│  Budget Check   │     ┌──────────────┐
│                 │────▶│ Reject if    │
│ - Daily limit   │     │ over budget  │
│ - Per-call est. │     └──────────────┘
└────────┬────────┘
         │ pass
┌────────▼────────┐
│ Provider Call   │
│                 │
│ OpenAI /        │
│ Anthropic       │
└────────┬────────┘
         │
┌────────▼────────┐
│ Output          │     ┌──────────────┐
│ Validation      │────▶│ Retry with   │
│ (Zod schema)    │     │ refined      │
│                 │ fail│ prompt       │
└────────┬────────┘     └──────────────┘
         │ pass
┌────────▼────────┐
│ Record:         │
│ - Cost tracking │
│ - Audit entry   │
│ - Explainability│
└────────┬────────┘
         │
         ▼
   Return validated output
```

## Job Capability Lifecycle

Async `kind: 'job'` capabilities follow a queue-backed path distinct from synchronous queries and actions:

```
POST /api/{domain}/{job-name}
    │
    ▼
┌─────────────────────┐
│ Access + validate   │
│ input               │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐     ┌──────────────────┐
│ INSERT              │     │ Publish to       │
│ job_executions      │────▶│ jobs queue       │
│ status: queued      │     └────────┬─────────┘
└─────────┬───────────┘              │
          │                          ▼
          │                 ┌──────────────────┐
          │                 │ Worker dequeues  │
          │                 │ markRunning      │
          │                 │ execute handler  │
          │                 │ markCompleted /  │
          │                 │ markFailed       │
          │                 └──────────────────┘
          ▼
   202 { data: { jobId, status: "accepted" } }
          │
          ▼ (client polls)
   GET /api/jobs/:jobId
```

MCP task dispatch with `jobQueue` configured follows the same enqueue path. See [Workers and Queues](./workers-and-queues.md).

## Context Assembly

When a capability is about to execute, the framework assembles the execution context. The factory lives on the framework-internal seam `@plumbus/core/runtime`, not on the `@plumbus/core` root barrel — it establishes the actor, so only runtime hosts (the transport packages and an application's own server bootstrap) construct contexts; capability code receives one, and tests use `createTestContext` from `@plumbus/core/testing`.

```
┌──────────────────────────────────────────────────┐
│             createExecutionContext(deps)          │
│                                                  │
│  deps.auth ──────────▶ ctx.auth                  │
│                        ctx.security              │
│  deps.data ──────────▶ ctx.data.{Entity}         │
│  deps.events ────────▶ ctx.events                │
│  deps.flows ─────────▶ ctx.flows                 │
│  deps.ai ────────────▶ ctx.ai                   │
│  deps.audit ─────────▶ ctx.audit                │
│  deps.translations ──▶ ctx.translations          │
│                        (locale per HTTP request) │
│  deps.capabilities ──▶ ctx.capabilities          │
│  deps.progress ──────▶ ctx.progress              │
│  deps.request ───────▶ ctx.request               │
│  deps.config ────────▶ ctx.config                │
│                        (locale per HTTP request) │
│  deps.logger ────────▶ ctx.logger                │
│                        (masked metadata keys)    │
│  (built-in) ─────────▶ ctx.errors                │
│  (built-in) ─────────▶ ctx.time                  │
└──────────────────────────────────────────────────┘
```

## Host runtime facade

`createPlumbusRuntime` is the host-facing surface. Wire the capability registry, flow engine, event pieces, scheduler, and (optionally) governed AI once. Callers then:

- `invokeCapability(name, input, { auth })` — runs the existing capability pipeline. The facade mints `ctx` internally; application code does not call `createExecutionContext`.
- `startFlow(name, input, { auth })` / `inspectExecution(id)` — delegate to the wired flow engine (`start` / `status`).
- `publishEvent` / `subscribe` / `pumpEvents` — wrap the existing emitter, consumer registry, and outbox dispatcher. Not a second bus.
- `syncTimers` / `pollTimers` — wrap the existing flow scheduler (`syncSchedules` / `poll`).
- `invokeGovernedAi(...)` — review-gated model call when host, approvals, and artifacts were wired.

```typescript
const runtime = createPlumbusRuntime({
  capabilities,
  flows: engine,
  events: emitter,
  eventPump: dispatcher,
  subscriptions: consumers,
  timers: scheduler,
  auth,
  contextDeps: { data },
});

const result = await runtime.invokeCapability("billing.getInvoice", { invoiceId });
const exec = await runtime.startFlow("example.flow-a", { orderId });
const snapshot = await runtime.inspectExecution(exec.id);
await runtime.publishEvent("example.accepted", { orderId });
await runtime.syncTimers();
```

## vNext durable dispatch (Protocol A)

The live flow engine still stores execution rows and leases in one database (`flow_executions`). The durable core evolves that engine toward **tenant-DB-authoritative state** with reconstructible spine hints — not a second workflow engine.

See [Dispatch and execution-state protocol](dispatch-state-protocol.md) for the ordered write pairs, persist-before-ack, lease rules, and orphan sweeps. The executable crash-matrix model lives at `packages/plumbus-core/src/testing/crash-matrix-simulation.ts`.


Capability-owned pre-side-effect admission can use the [request admission primitives](../security/request-admission.md), with shared transaction locks and bundled work challenges.

[Validation maintenance](../testing/validation-maintenance.md) documents explicit durable-record and compensation checks and their regression coverage.

## Optional sampled telemetry (unreleased)

Request, capability and worker-step boundaries derive children and report completion through a
non-blocking host hook. Carriers live outside business/auth JSON and restore from verified rows.
See [the contract and migration checklist](../sdk-reference/telemetry.md).
