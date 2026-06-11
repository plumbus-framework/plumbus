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
                       │    ┌────────▼─────────┐     ┌───────────┐
                       │    │ Evaluate Access   │────▶│  403      │
                       │    │ Policy            │ no  │ Forbidden │
                       │    └────────┬─────────┘     └───────────┘
                       │             │ yes
                       │    ┌────────▼─────────┐     ┌───────────┐
                       │    │ Validate Input    │────▶│  400      │
                       │    │ (Zod schema)      │ err │ Validation│
                       │    └────────┬─────────┘     └───────────┘
                       │             │ ok
                       │    ┌────────▼─────────┐
                       │    │ Create Execution  │
                       │    │ Context (ctx)     │
                       │    └────────┬─────────┘
                       │             │
                       │    ┌────────▼─────────┐
                       │    │ Begin Transaction │
                       │    └────────┬─────────┘
                       │             │
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
                       │    │ Commit Transaction│
                       │    │ (data + outbox)   │
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
│  Initialize  │────▶│  pending ──▶ running ──▶ completed   │
│  execution   │     │              │    │                    │
│              │     │              │    ├──▶ failed          │
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
│  { stepName, status, startedAt, completedAt, output }    │
└──────────────────────────────────────────────────────────┘
```

## Event Processing Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Handler     │     │   Outbox     │     │  Dispatcher  │
│              │     │   Table      │     │              │
│ ctx.events   │────▶│ (PostgreSQL) │────▶│  Poll every  │
│   .emit()    │     │              │     │  100ms       │
│              │     │ ┌──────────┐ │     │              │
│ (same TX as  │     │ │ eventType│ │     │  Mark as     │
│  data write) │     │ │ payload  │ │     │  dispatched  │
│              │     │ │ tenantId │ │     │              │
└──────────────┘     │ │ status   │ │     └──────┬───────┘
                     │ └──────────┘ │            │
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
│ Security Check  │────▶│ Block if     │
│                 │     │ input contains│
│ - PII detection │     │ restricted   │
│ - Scope check   │     │ data         │
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
   202 { jobId, status: "accepted" }
          │
          ▼ (client polls)
   GET /api/jobs/:jobId
```

MCP task dispatch with `jobQueue` configured follows the same enqueue path. See [Workers and Queues](./workers-and-queues.md).

## Context Assembly

When a capability is about to execute, the framework assembles the execution context:

```
┌──────────────────────────────────────────────────┐
│             createExecutionContext(deps)          │
│                                                  │
│  deps.auth ──────────▶ ctx.auth                  │
│                        ctx.security              │
│  deps.entityRegistry ─▶ ctx.data.{Entity}        │
│  deps.eventEmitter ───▶ ctx.events               │
│  deps.flowService ────▶ ctx.flows                │
│  deps.aiService ──────▶ ctx.ai                   │
│  deps.auditService ───▶ ctx.audit                │
│  deps.config ─────────▶ ctx.config               │
│  deps.logger ─────────▶ ctx.logger               │
│  (built-in) ──────────▶ ctx.errors               │
│  (built-in) ──────────▶ ctx.time                 │
└──────────────────────────────────────────────────┘
```

