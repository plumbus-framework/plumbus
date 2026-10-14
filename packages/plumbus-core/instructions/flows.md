# Flows

A flow is a multi-step workflow that orchestrates capabilities in sequence, with support for branching, parallel execution, waits, and delays.

## Defining a Flow

```ts
import { defineFlow } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const refundApproval = defineFlow({
  name: "refundApproval",
  domain: "billing",

  input: z.object({ refundId: z.string(), amount: z.number() }),
  state: z.object({ approved: z.boolean().default(false) }),

  steps: [
    { type: "capability", name: "validateRefund", capability: "billing.validateRefund" },
    { type: "conditional", name: "checkAmount", if: "amount > 100", then: "managerApproval", else: "autoApprove" },
    { type: "wait", name: "managerApproval", event: "refund.approved" },
    { type: "capability", name: "autoApprove", capability: "billing.autoApprove" },
    { type: "capability", name: "processRefund", capability: "billing.processRefund" },
    { type: "eventEmit", name: "notifyCustomer", event: "refund.completed" },
  ],

  trigger: { event: "refund.requested" },
  retry: { maxAttempts: 3, backoff: "exponential" },
});
```

## Step Types

| Type | Purpose | Key Fields |
|------|---------|-----------|
| `capability` | Execute a named capability | `name` (step id), `capability` (canonical `<domain>.<name>`) |
| `conditional` | Branch based on condition | `if`, `then`, `else` |
| `wait` | Pause until event or timeout | `event` |
| `delay` | Pause for a fixed duration | `duration` (e.g., `"24h"`, `"5m"`) |
| `parallel` | Run multiple steps concurrently | `branches` (step names) |
| `eventEmit` | Emit a framework event | `event` |
| `approval-outcome` | Route on Stage 4 approval decision | `outcomes` |

### Conditional Syntax

The `if` field accepts a JavaScript-like expression string. You can reference the flow `input` and `state` directly:

```ts
// Simple comparison against input
{ type: "conditional", name: "checkAmount", if: "input.amount > 100", then: "managerApproval", else: "autoApprove" }

// Reference flow state
{ type: "conditional", name: "checkApproval", if: "state.approved", then: "processRefund", else: "escalate" }

// Logical operators
{ type: "conditional", name: "checkBoth", if: "input.amount > 100 && state.retryCount < 3", then: "retry", else: "fail" }
```

The `then` and `else` values reference step **names** within the same flow. Execution jumps to the named step.

### Parallel Branches

```ts
{ type: "parallel", name: "notifyAll", branches: ["sendEmail", "sendSms", "logAudit"] }
```

All branches execute concurrently. The flow waits for **all** branches to complete before advancing. If any branch fails, the entire parallel step fails.
## Flow step auth and job blocking

Flow capability steps run under the **caller's auth snapshot** stored in `flow_executions.auth_snapshot_json` — not auto-`system` on user-triggered flows. Capabilities must allow the original caller's roles/scopes (or `public`). Scheduled flows still run under explicit `system` auth from the scheduler.

**Job capabilities** cannot run synchronously inside a flow step. Use job dispatch, events, or async consumers instead — the step executor returns `dependencyViolation` when a step references `kind: 'job'`.

Flow steps are **not** subject to a parent capability's `effects.capabilities`; only handler-to-handler `ctx.capabilities.invoke` requires declared dependencies.

## State Management

Flows maintain a `state` object persisted across steps. Each step can read and modify state through the flow execution context.

```ts
state: z.object({
  approved: z.boolean().default(false),
  reviewerId: z.string().optional(),
  retryCount: z.number().default(0),
})
```

## Triggers

### Event-triggered
```ts
trigger: { event: "order.placed" }
```
When the named event fires, a new flow execution starts with the event payload mapped to the flow input.

### Scheduled
```ts
schedule: { cron: "0 9 * * MON", timezone: "UTC", firstRun: "next", overlap: "skip" }
```

Scheduled flows receive `{}` under scheduler auth: use `input: z.object({})` or defaults. New schedules default to an immediate first run on the next poll; `firstRun: "next"` waits for the first boundary. Default overlap is allowed and the default timezone is process-local. An expired lease does not make a previous execution finished. Core owns the cron parser.

Scheduled flows run through the one framework scheduler (`createFlowScheduler`, persisted `flow_schedules` rows); do not add a second scheduler. Overdue ticks coalesce into one run by default (`schedule.catchUpPolicy: "skip"`); set `catchUpPolicy: "catch-up"` for bounded catch-up of missed ticks.

Startup seeds the initial schedule set only; use deployment reconciliation for subsequent additions. Use `plumbus flow schedule sync` to preview definition changes/removal, then `--apply --expected-revision <revision>` from one deployment owner. Persisted overrides are reviewed during adoption; disabled schedules stay disabled. Inspect `plumbus flow schedule list --json`. Read `deployment.md` and `stabilization.md` before scaling schedulers or upgrading existing rows.

### Manual
```ts
// From a capability handler:
await ctx.flows.start("refundApproval", { refundId: "rf_123", amount: 150 });
```

## Retry Policy

```ts
retry: {
  maxAttempts: 3,    // Total calls per step activation; legacy attempts: N means N retries
  backoff: "exponential"  // "exponential" or "fixed"
}
```

Steps that fail with transient errors are retried. Permanent failures stop the flow and move it to the dead-letter queue.

Operators can stop an open execution through the framework service. `ctx.flows.cancel(id)`
aborts the active step and runs every declared compensation for completed steps;
`ctx.flows.terminate(id)` aborts and closes the execution without compensation. Both leave the
execution in the terminal `cancelled` state, never `completed`; applications should audit the
operator, reason, and which action was chosen in their recovery capability.

## Compiled definitions

`plumbus compile-flows` emits signed JSON from `defineFlow` modules. Pass `compiledRegistry` to `createFlowEngine` so production runs consume compiled JSON (not live TypeScript steps) and pin version+digest on `flow_executions`. `approval-outcome` steps use Stage 4 `ApprovalService`. `applyDefinitionStrategy(..., 'migrate')` is not supported. Do not write a second workflow engine.

## Flow Lifecycle

`created → running → waiting → running → completed | failed | cancelled`

- Steps execute sequentially (except `parallel`)
- Every step produces an audit record
- Failed flows with exhausted retries land in a dead-letter queue for manual inspection


Core 0.7.0 rejects missing, malformed, or actor/tenant-inconsistent stored auth snapshots before a step executes. New snapshots omit session IDs and authentication timestamps. Do not recover legacy rows by injecting worker/system roles; follow [the security release checklist](./upgrading-security-release.md) with a verified initiating identity and a review of prior effects.


## Cancellation, retries, and replay

Retries persist their wake time and release the worker. Each successful step advancement resets the retry budget. Permanent failures are not retried: validation, authorization and dependency errors, a flow `budget` that runs out, and an AI budget stop (`budget-exhausted`) fail the execution immediately. Cancellation invalidates ownership and signals `ctx.signal`; it cannot undo an external effect. Make side effects idempotent.

Failed executions automatically receive a dead-letter snapshot, with a recovery sweep if copying fails. `plumbus flow dead-letter list` lists those snapshots. `plumbus flow dead-letter retry <executionId> [--actor <id>]` creates a new replay at the failed step and returns its ID; the failed original remains immutable, the replay keeps the original's compiled-definition pin, and the dead letter records `replayedBy`. Concurrent requests reuse the same replay ID. Invalid original auth or incompatible current step/state prevents replay. `--in-place` instead resets the same execution (`retryDeadLetteredFlow`), at most once and never after a replay.

Flow capabilities can enqueue jobs through `ctx.jobs.enqueue()` with restored caller identity. Built-in transactions persist job intent before commit and publish afterward; queued work remains recoverable after broker failures. A returned ID means acceptance, not completion. Synchronous job-capability steps remain unsupported. With a worker data-plane resolver, a flow step that runs on a resolved tenant plane has no job queue yet: `ctx.jobs.enqueue()` throws `Job queue not configured on this execution context`.

Wait signals are fenced to their original waiting activation; a stale signal cannot advance a later activation of the same wait. Retry and schedule deadlines use database time, and Redis visibility uses Redis time.
