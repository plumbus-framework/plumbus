# Flows

Flows orchestrate multiple capabilities into **structured, multi-step workflows**. They support sequential execution, conditional branching, parallel processing, event-driven waits, and automatic retries.

## Defining a Flow

```typescript
import { defineFlow } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const orderFulfillment = defineFlow({
  name: "orderFulfillment",
  domain: "orders",
  description: "Process an order from payment to delivery",
  input: z.object({ orderId: z.string().uuid() }),
  trigger: { event: "order.placed" },
  steps: [
    { name: "validateOrder", type: "capability", capability: "orders.validateOrder" },
    { name: "processPayment", type: "capability", capability: "billing.processPayment" },
    {
      name: "checkInventory",
      type: "conditional",
      if: "state.paymentStatus === 'success'",
      then: "createShipment",
      else: "cancelOrder",
    },
    { name: "createShipment", type: "capability", capability: "shipping.createShipment" },
    { name: "cancelOrder", type: "capability", capability: "orders.cancelOrder" },
    {
      name: "notifyAll",
      type: "parallel",
      branches: ["sendEmail", "sendSms", "updateDashboard"],
    },
    { name: "sendEmail", type: "capability", capability: "notifications.sendOrderEmail" },
    { name: "sendSms", type: "capability", capability: "notifications.sendOrderSms" },
    { name: "updateDashboard", type: "capability", capability: "orders.updateOrderDashboard" },
  ],
  retry: { attempts: 3, backoff: "exponential" },
});
```

## Step Types

### Capability Step

Executes a capability by **canonical name** (`<domain>.<capabilityName>`):

```typescript
{ name: "validateOrder", type: "capability", capability: "orders.validateOrder" }
```

Flow `capability` steps use the flow runtime — they are **not** subject to a parent capability's `effects.capabilities`. Only handler-to-handler calls via `ctx.capabilities.invoke` require declared dependencies (see [capabilities](./capabilities.md#capability-to-capability-invocation)).

**Job capabilities** cannot run synchronously inside a flow step. Use job dispatch, an event-triggered flow, or an async job consumer instead — the flow step executor returns `dependencyViolation` / `unsupportedTargetKind` when a step references a `kind: 'job'` capability.

Flow step execution does **not** inherit the worker's `system` roles. When a flow starts, the framework stores the caller's full `AuthContext` in `flow_executions.auth_snapshot_json` and restores it on each step (with `actor` / `tenant_id` from the row). Scheduled and worker-owned flows still run under explicit `system` auth from the worker bootstrap; user-triggered flows keep the caller's roles and scopes.

By default, each capability step receives the **merged flow input + flow state** as its input. You can also provide explicit `input` overrides with template references:

```typescript
{
  name: "extractEvents",
  type: "capability",
  capability: "timeline.extractTimelineEvents",
  input: {
    sourceType: "interview_message",          // literal value
    sourceReferenceId: "$input.messageId",    // resolved from flow input
    cached: "$state.metadataId",              // resolved from flow state
  },
}
```

Template syntax:
- `$input.fieldName` — resolves to the named field from the flow's trigger input
- `$state.fieldName` — resolves to the named field from the flow's mutable state
- Any other value — used as a literal

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Step 1      │────▶│ Step 2      │────▶│ Step 3      │
│ validateOrder│    │processPayment│    │createShipment│
└─────────────┘     └─────────────┘     └─────────────┘
```

### Conditional Step

Branches based on a condition:

```typescript
{
  name: "route",
  type: "conditional",
  if: "state.amount > 100",
  then: "managerApproval",
  else: "autoApprove",
}
```

```
                    ┌──────────────┐
                    │   condition  │
                    │ amount > 100 │
                    └──────┬───────┘
                     true /  \ false
                         /    \
              ┌─────────▼┐  ┌─▼─────────┐
              │ manager  │  │ auto      │
              │ Approval │  │ Approve   │
              └──────────┘  └───────────┘
```

### Parallel Step

Executes multiple branches concurrently via `Promise.allSettled()`:

```typescript
{
  name: "notifyAll",
  type: "parallel",
  branches: ["sendEmail", "sendSms", "updateDashboard"],
}
```

```
              ┌──────────────┐
              │  notifyAll   │
              │  (parallel)  │
              └──────┬───────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
   ┌─────▼────┐ ┌───▼─────┐ ┌──▼────────┐
   │sendEmail │ │ sendSms │ │ update   │
   │          │ │         │ │Dashboard │
   └─────┬────┘ └───┬─────┘ └──┬────────┘
         │           │           │
         └───────────┼───────────┘
                     │
                  Continue
```

### Wait Step

Pauses until a specific event is received:

```typescript
{
  name: "waitForApproval",
  type: "wait",
  event: "refund.approved",
}
```

### Delay Step

Pauses for a fixed duration:

```typescript
{
  name: "cooldown",
  type: "delay",
  duration: "5m",
}
```

### Event Emit Step

Emits an event as a flow step:

```typescript
{
  name: "notifyComplete",
  type: "eventEmit",
  event: "order.fulfilled",
}
```

The emitted payload is built from the original flow input merged with the current flow state. When both contain the same key, the current flow state wins.

## Passing large payloads by reference

Flow state is stored as a single `jsonb` column on `flow_executions`. After each step, the engine **merges** the step's successful output into that column and rewrites the **entire** value on every subsequent step boundary (and copies it into `flow_dead_letter` if the run is dead-lettered). A large string or object in a step's **return value** is therefore re-serialized and written to the database on every later step — even though the in-memory merge is only a shallow spread.

**Convention:** store the bytes once in an app-defined entity via `ctx.data`, and pass only an **id** through flow state. `ctx.data` inside flow steps is tenant-scoped and audited like any other capability (see [Entities](./entities.md)).

### Entity and flow definition

```typescript
import { defineEntity, defineFlow, field } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const Document = defineEntity({
  name: "Document",
  tenantScoped: true,
  fields: {
    id: field.id(),
    body: field.json(),
  },
});

export const processDocument = defineFlow({
  name: "processDocument",
  domain: "documents",
  input: z.object({ body: z.unknown() }),
  steps: [
    { name: "storeDocument", type: "capability", capability: "documents.storeDocument" },
    {
      name: "analyzeDocument",
      type: "capability",
      capability: "documents.analyzeDocument",
      input: { documentId: "$state.documentId" },
    },
  ],
});
```

### Step handlers

**Store once, return only the id** (only this object is merged into persisted state):

```typescript
// storeDocument capability
const row = await ctx.data.Document.create({ body: bigBlob });
return { documentId: row.id };
```

**Load on demand** (receives only the ref when `step.input` is declared as above):

```typescript
// analyzeDocument capability
const doc = await ctx.data.Document.findById(input.documentId);
// use doc.body ...
```

Use the same [`$input` / `$state` template syntax](#capability-step) as other capability steps.

### What narrows input vs what persists

Declaring `step.input` only controls what the **capability handler receives**; it does **not** remove keys from persisted flow state. Keep large values out of the step **return value** — narrowing input alone does not shrink the column.

On downstream steps, prefer explicit `step.input` (for example `{ documentId: "$state.documentId" }`). Without it, the step receives the **full** merge of trigger input and state, including any leftover large fields.

### Other places large data hurts

- **Trigger input** — `ctx.flows.start(name, { body: bigBlob })` is written once to `flow_executions.input` but re-read every step, merged into default capability input, and copied on dead-letter. Keep large bytes out of **both** start input and step outputs.
- **`eventEmit` steps** — the emitted event payload is the full input+state merge; a blob in state is published to the outbox too.
- **Merge-only state** — there is no engine "delete from state"; once a key is merged in, every later step pays for it until a step **overwrites** that key with a smaller value. Returning `{ body: null }` replaces the value but the key remains in the jsonb object.
- **Explicit `step.input` on consumers** — without `step.input`, a capability receives the full input+state merge, including any large fields still in state. Declare only the refs you need (for example `{ documentId: "$state.documentId" }`).
- **Parallel branches** — branch outputs use the same merge rules; return only refs from parallel capability steps as well.

Row lifecycle (retention, explicit delete) is the app's responsibility — use the entity's `retention` config or a final cleanup capability.

## Triggers and Schedules

A flow definition can carry **either** a `trigger` (event-driven), **or** a `schedule` (cron), **or** neither (the flow runs only when started programmatically via `ctx.flows.start()` or the auto-routed start endpoint).

| Field | Configuration | When the flow starts |
|-------|---------------|---------------------|
| `trigger` | `{ event: "order.placed" }` | When the named event is emitted (worker pool consumes from the outbox). |
| `schedule` | `{ cron: "0 0 * * *" }` | On the cron schedule (handled by the scheduler). |
| *(neither)* | — | Only via `ctx.flows.start(...)` or the auto-generated start route. |

Do not combine `trigger` and `schedule` on the same flow — pick one initiation model.

### Scheduled flow example

Use `schedule.cron` when work should run on a timer (nightly cleanup, hourly sync, etc.). The flow scheduler lives in the **worker pool** and writes run state to the `flow_schedules` table.

```typescript
import { defineFlow } from "@plumbus/core";
import { z } from "zod";

export const nightlyCleanup = defineFlow({
  name: "nightlyCleanup",
  domain: "maintenance",
  description: "Purge expired records every day at midnight",
  input: z.object({}), // scheduler starts the flow with {} — no event payload
  schedule: { cron: "0 0 * * *" }, // every day at 00:00 (5-field cron)
  steps: [
    {
      name: "purgeExpired",
      type: "capability",
      capability: "maintenance.purgeExpired",
    },
  ],
});
```

Register the flow in your app registry (same as event-triggered flows). On worker startup, the scheduler syncs registered schedules into `flow_schedules` and polls for due runs.

**Cron formats**

| Pattern | Example | Meaning |
|---------|---------|---------|
| 5-field cron | `"0 0 * * *"` | Every day at midnight (`minute hour day month weekday`) |
| 5-field cron | `"*/15 * * * *"` | Every 15 minutes |
| Interval | `"every:60m"` | Every 60 minutes |
| Interval | `"every:24h"` | Every 24 hours |
| Interval | `"every:1d"` | Every 1 day |

Fields: minute (0–59), hour (0–23), day-of-month (1–31), month (1–12), day-of-week (0–6, Sunday = 0). Wildcards, ranges, steps, and lists are supported. With `cron-parser` installed, expressions are delegated to that library first.

**Runtime requirements**

1. **Worker pool** — `plumbus dev` / `plumbus start` (role `all`) or a dedicated `plumbus worker start` process. See [Workers and queues](../architecture/workers-and-queues.md).
2. **`cron-parser` (recommended)** — accurate `nextRunAt` for production cron:

   ```bash
   pnpm add cron-parser
   ```

3. **Migrations** — `flow_schedules` is included in generated migrations; run `plumbus migrate generate` then `plumbus migrate apply`.

**Auth and capabilities**

Scheduled runs start with empty input `{}` under **system** auth (`roles: ['system']`, provider `scheduler`). Capabilities invoked by scheduled steps must allow that identity — for example:

```typescript
access: {
  roles: ["system"],
  // or: serviceAccounts: ["scheduler"],
}
```

User-scoped data in scheduled steps still respects tenant rules on `ctx.data`; there is no end-user `AuthContext` on cron-triggered runs.

**Operational notes**

- Inspect schedules: `plumbus flow schedule list` (or `--json`). Merges app definitions with `flow_schedules` run state.
- Default poll interval: `schedulerPollIntervalMs` = 60_000 (1 minute). Tune in worker config — see [configuration](../sdk-reference/configuration.md#worker-pool).
- First sync of a new schedule sets `nextRunAt` to **now**, so the first run happens on the next poll (not necessarily exactly at cron boundary).
- Verify the scheduler is active: `plumbus worker status` reports a `scheduler` component when scheduled flows are registered.
- Split deployments (API-only + worker-only) need Redis for durable queues when running multiple replicas — see [upgrading-workers](../upgrading-workers.md).

## Retry Policy

```typescript
retry: {
  attempts: 3,            // total attempts including the first
  backoff: "exponential", // "fixed" | "exponential"
}
```

Backoff strategies:
- `fixed` — same delay between each retry.
- `exponential` — delay doubles between retries.

## Multi-Worker Safety & Leasing

Plumbus is built for horizontal scale: any number of worker processes can share one database without executing the same step twice. Safety is enforced at the row level — each flow execution is held by at most one worker at a time via a time-bounded lease.

**How claims work.** Each poll cycle, `claimNext()` runs a single atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` against `flow_executions`. Postgres' `SKIP LOCKED` guarantees that concurrent workers never lock the same row, so each returned execution is owned by exactly the worker that claimed it. Expired leases (from a crashed worker) are picked up by the same query.

**Automatic heartbeat.** While a step is running, the engine extends the lease on a timer (`flowHeartbeatIntervalMs`, default 1/3 of the lease duration). Each tick issues a `UPDATE … WHERE id = $1 AND lease_owner = $workerId`; if zero rows match, the lease has been stolen and the worker aborts the step.

**Manual heartbeat.** Long-running step handlers that span multiple lease intervals can call `ctx.flows.heartbeat()` to extend the lease explicitly. Outside of flow execution it's a no-op, so helper code that calls it stays portable.

**`LeaseLostError`.** Thrown from `runNext` (and from `ctx.flows.heartbeat()`) when the lease has moved to another worker. If you handle it, do not write to the execution or emit events — the current lease holder is authoritative and will own the commit. In practice, workers bubble this error up to the poll loop and move on to the next row.

See [configuration](../sdk-reference/configuration.md#flow-lease-tuning) for the `flowLeaseDurationMs`, `flowHeartbeatIntervalMs`, and `flowClaimBatchSize` knobs.

## Cancellation

Inside a flow step handler, `ctx.signal` is an `AbortSignal` that fires when:

- `ctx.flows.cancel(executionId)` is called (in this process or any peer worker), OR
- the worker loses its lease on the execution.

Capability handlers can pass it to cancelable HTTP / AI calls so a cancel request stops in-flight work cooperatively, rather than letting a zombie step burn budget after the user gave up:

```typescript
handler: async (ctx, input) => {
  // AI helpers default `signal` to `ctx.signal` automatically — explicit pass shown for clarity.
  const summary = await ctx.ai.generate({
    prompt: "summarizeTicket",
    input: { body: input.body },
    signal: ctx.signal,
  });

  // External HTTP — pass the signal so fetch aborts on cancel
  const reply = await fetch(input.callbackUrl, { signal: ctx.signal });

  // Long loops should poll
  for (const item of input.items) {
    if (ctx.signal?.aborted) break;
    await processItem(item);
  }
};
```

`ctx.workerId` is also available inside step execution for diagnostic logging — it matches the `lease_owner` column on the active flow execution row.

**`FlowCancelledError`.** Raised as the `AbortSignal.reason` when a step is cancelled via `flows.cancel()`. The DOM `fetch` API surfaces aborts as `DOMException("AbortError")`; the reason is available on `signal.reason` for handlers that want to distinguish cancellation from other abort sources.

## Operations: upgrading the flow_executions schema

The lease-based engine added in 0.3.0 stores `lease_owner` and `lease_expires_at` columns on `flow_executions`, plus a `flow_exec_lease_idx` index. Worker startup runs a preflight against these columns and refuses to start with a clear migration prompt when they're missing:

```
Plumbus 0.3.0 requires new columns on flow_executions
(lease_owner, lease_expires_at).
Run `plumbus migrate generate` then `plumbus migrate apply`
before starting workers.
```

On upgrade from 0.2.x, run:

```bash
plumbus migrate generate   # emits ALTER TABLE + CREATE INDEX
plumbus migrate apply
```

The preflight runs automatically when workers start. For custom worker bootstraps, import `assertFlowLeaseColumns` from `@plumbus/core` (re-exported via `worker/index.ts`) and call it against your Drizzle database before starting the pool.

`auth_snapshot_json` is included in generated migrations for new installs and upgrades. Rows created before the column exists fall back to worker auth for roles until migrated; run `plumbus migrate generate` and `plumbus migrate apply` after upgrading framework versions that add this column.

## Flow State Machine

```
                ┌─────────┐
                │ created │
                └────┬────┘
                     │ start
                ┌────▼────┐
          ┌─────│ running │─────┐
          │     └────┬────┘     │
          │          │          │
     fail │     done │     wait │
          │          │          │
     ┌────▼────┐ ┌──▼──────┐ ┌▼────────┐
     │ failed  │ │completed│ │ waiting │
     └─────────┘ └─────────┘ └────┬────┘
                                   │ resume
                              ┌────▼────┐
                              │ running │
                              └─────────┘
```

## Flow Execution History

Each step produces a `StepHistoryEntry`:

```typescript
{
  step: "processPayment",
  status: "completed",       // "completed" | "failed" | "skipped"
  startedAt: Date,
  completedAt?: Date,
  error?: string,
}
```

The full history is accessible for debugging and audit.

## Dead Letter

Failed flows that exhaust retries are sent to the `flow_dead_letter` table.

### Operational CLI

```bash
plumbus flow dead-letter list [--limit 20] [--json]
plumbus flow dead-letter retry <executionId>
```

`retry` re-enqueues the next step on the flows queue after an operator fix.

### Programmatic API

```typescript
import { sweepFailedFlows, deadLetterFlow } from "@plumbus/core";

// Manually dead-letter a flow
await deadLetterFlow(executionId, "Manual intervention required");

// Sweep all failed flows past retry limit
await sweepFailedFlows(flowService);
```

## File Convention

```
app/flows/{domain}/{flow-name}/
├── flow.ts          # Flow definition (defineFlow)
└── tests/
    └── {name}.test.ts
```

---

## SDK reference

For every `defineFlow` option, the full step-type list, and the `FlowRetryPolicy` / `FlowTrigger` / `FlowSchedule` shapes, see [SDK Reference → defineFlow](../sdk-reference/define-functions.md#defineflow). This page covers the common case; the reference is exhaustive.

