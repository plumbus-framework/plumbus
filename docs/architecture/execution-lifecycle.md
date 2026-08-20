# Execution Lifecycle

This document traces the complete lifecycle of a request through the Plumbus framework.

## Capability Execution Flow

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
                       │    │ Validate Input    │────▶│  400      │
                       │    │ (Zod schema)      │ err │ Validation│
                       │    └────────┬─────────┘     └───────────┘
                       │             │ ok
                       │    ┌────────▼─────────┐     ┌───────────┐
                       │    │ Evaluate Access   │────▶│  403      │
                       │    │ Policy            │ no  │ Forbidden │
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

