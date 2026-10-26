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
  version: "1",
});
```

## Compiled definitions

Authoring stays TypeScript. `plumbus compile-flows` (and `compileFlowDefinition`) extracts steps, hoists condition expressions and step `input` mappings into individually digested bindings, and emits signed JSON with `flowDefinitionId` (`{domain}.{name}`), `definitionVersion`, and `definitionDigest`. Inline expressions are prohibited in the signed artifact.

`CompiledFlowRegistry` retains every published `(flowDefinitionId, definitionVersion)` immutably. `plumbus compile-flows` writes signed JSON under `.plumbus/compiled-flows`. `loadCompiledFlowRegistryFromDirectory` (and `tryLoadCompiledFlowRegistryFromDirectory`) reloads those files into a new registry, recomputing `definitionDigest` and refusing a mismatch. `createServer` and `createWorkerPool` use that load: pass `compiledRegistry`, or `compiledFlowsDirectory`, or leave both off to load `{cwd}/.plumbus/compiled-flows` when that tree has JSON. When a registry is set, the engine **consumes compiled JSON** (not live TypeScript steps): `start` requires a published version and writes `definition_version` + `definition_digest` on `flow_executions`. Later `runNext` / `resume` restore that pin from the row (complete-on-original), including across process restarts. Omit the registry (and have no compiled-flows tree) and the engine keeps today's live `FlowRegistry` objects.

`approval-outcome` steps route on an approval decision (`approved` / `rejected` / `changes-requested`) via `createApprovalService`. In-flight strategies: `complete-on-original` (default), `stop-and-recover` (cancel + record), `migrate` throws `definition-strategy-not-supported` — never a silent no-op.

```bash
plumbus compile-flows [--out .plumbus/compiled-flows] [--json]
```

Hosts that should not assemble the engine per call use `createPlumbusRuntime({ flows: engine, auth }).startFlow(...)` and `inspectExecution(id)`. The same facade wraps the existing scheduler as `syncTimers` / `pollTimers` when you pass `timers: scheduler`. See [Execution lifecycle — Host runtime facade](../architecture/execution-lifecycle.md#host-runtime-facade).

## Step Types

### Capability Step

Executes a capability by **canonical name** (`<domain>.<capabilityName>`):

```typescript
{ name: "validateOrder", type: "capability", capability: "orders.validateOrder" }
```

Flow `capability` steps use the flow runtime — they are **not** subject to a parent capability's `effects.capabilities`. Only handler-to-handler calls via `ctx.capabilities.invoke` require declared dependencies (see [capabilities](./capabilities.md#capability-to-capability-invocation)).

**Job capabilities** cannot run synchronously inside a flow step. Use job dispatch, an event-triggered flow, or an async job consumer instead — the flow step executor returns `dependencyViolation` / `unsupportedTargetKind` when a step references a `kind: 'job'` capability.

Flow step execution does **not** inherit the worker's `system` roles. When a flow starts, the framework stores the caller's authorization fields in `flow_executions.auth_snapshot_json` and validates and restores them on each step against the row actor/tenant. Scheduled and worker-owned flows still run under explicit `system` auth from the worker bootstrap; user-triggered flows keep the caller's roles and scopes.

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
  event: "approval_pending",
}
```

`approval_pending` (`APPROVAL_PENDING_WAIT`) is the Stage 4 wait event for an in-flight approval. It uses this Wait step — not a second engine. See [approvals](./approvals.md).

### Delay Step

Pauses for a fixed duration:

```typescript
{
  name: "cooldown",
  type: "delay",
  duration: "5m",
}
```

`ctx.flows.wake(executionId)` ends a delay early; see [Waking a delayed flow](#waking-a-delayed-flow).

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

A flow can also be started from a chat conversation: list it in a chat's
`policy.toolCalling.autoStartFlows` and the runtime binds it as a `flow__<name>` provider
tool. Per-turn limits (`maxFlowStartsPerTurn`, `flowAwaitBudgetMsPerTurn`) bound how much
flow work a single turn may trigger. See
[chat → provider-native tool calling](../chat/defining-chats.md#provider-native-tool-calling-policytoolcalling-path-b).

### Scheduled flow example

Use `schedule.cron` when work should run on a timer (nightly cleanup, hourly sync, etc.). The flow scheduler lives in the **worker pool** and writes run state to the `flow_schedules` table. `nextRunAt` is the wake time. Missed ticks honor `schedule.catchUpPolicy`: default `skip` (one start, jump to the next future slot); `catch-up` starts once per missed slot up to a bound of 3. This is the existing scheduler — not a second timer engine.

```typescript
import { defineFlow } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const nightlyCleanup = defineFlow({
  name: "nightlyCleanup",
  domain: "maintenance",
  description: "Purge expired records every day at midnight",
  input: z.object({}), // scheduler starts the flow with {} — no event payload
  schedule: { cron: "0 0 * * *", timezone: "UTC", firstRun: "next", overlap: "skip" },
  steps: [
    {
      name: "purgeExpired",
      type: "capability",
      capability: "maintenance.purgeExpired",
    },
  ],
});
```

Register the flow in your app registry (same as event-triggered flows). Worker startup seeds the initial schedule set only when no schedule rows exist. For subsequent additions, changes, and removals, preview `plumbus flow schedule sync`, then apply with `--apply --expected-revision <revision>` from the complete intended deployment registry. The scheduler polls adopted, enabled definitions for due runs. Hosts that drive timers themselves call the same startup seed and poll through `createPlumbusRuntime({ timers: scheduler }).syncTimers()` and `pollTimers()`. A failed poll (for example, the database is unreachable) logs `Scheduler poll failed; durable ticks remain recoverable` with the error message, and the next poll picks the due runs up.

**Cron formats**

| Pattern | Example | Meaning |
|---------|---------|---------|
| 5-field cron | `"0 0 * * *"` | Every day at midnight (`minute hour day month weekday`) |
| 5-field cron | `"*/15 * * * *"` | Every 15 minutes |
| Interval | `"every:60m"` | Every 60 minutes |
| Interval | `"every:24h"` | Every 24 hours |
| Interval | `"every:1d"` | Every 1 day |

Fields: minute (0–59), hour (0–23), day-of-month (1–31), month (1–12), day-of-week (0–6, Sunday = 0). Wildcards, ranges, steps, and lists are supported by the core-owned `cron-parser` dependency. Invalid schedules fail validation; there is no fallback to an hourly schedule. Set an IANA `timezone` explicitly for consistent deployments.

**Runtime requirements**

1. **Worker pool** — `plumbus dev` / `plumbus start` (role `all`) or a dedicated `plumbus worker start` process. See [Workers and queues](../architecture/workers-and-queues.md).
2. **Cron parsing** — provided by core; consumers do not install `cron-parser` separately.
3. **Migrations** — `flow_schedules`, `flow_schedule_ticks`, and flow ownership/replay metadata are included in generated migrations; run `plumbus migrate generate` then `plumbus migrate apply`. Follow the [coordinated cutover guide](../upgrading-stabilization.md) for existing deployments.

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
- Default poll interval: `schedulerPollIntervalMs` = 60_000 (1 minute). Tune in worker config — see [configuration](../sdk-reference/configuration.md#worker-pool-configuration).
- New schedules default to `firstRun: 'immediate'`: the first run is due on the next poll. Set `firstRun: 'next'` to wait for the first cron boundary, as in the example above.
- Default overlap is `allow`; `overlap: 'skip'` records a skipped tick while a previous scheduled execution is created, running, or waiting. An expired lease is still recoverable work. Overdue ticks coalesce into one run before computing the next future occurrence.
- Tick creation, execution creation, and schedule advancement share one database transaction. Queue notifications are recoverable hints. Operator-disabled schedules stay disabled during reconciliation, and removals retain tombstones and history.
- Verify the scheduler is active: `plumbus worker status` reports a `scheduler` component when scheduled flows are registered.
- Split deployments (API-only + worker-only) need Redis for durable queues when running multiple replicas — see [upgrading-workers](../upgrading-workers.md).

## Retry Policy

```typescript
retry: {
  maxAttempts: 3,         // total calls per step activation (core 0.8+)
  backoff: "exponential", // "fixed" | "exponential"
}
```

Backoff strategies:
- `fixed` — same delay between each retry.
- `exponential` — delay doubles between retries.

A failed step with retries remaining moves to `waiting`, clears its worker lease, and keeps the
same `currentStep`. `wakeAt` is the computed backoff instant; polling workers and durable queue
schedulers cannot claim it before then. In tenant-data-plane deployments the retry transition is
persist-before-ack: `execution_state`, the retry `wait_state`, and a future-dated
`dispatch_outbox` row commit together before the current spine hint is acknowledged.

## Multi-Worker Safety & Leasing

Plumbus uses fenced database transitions for horizontal scale. Execution and external side effects remain at-least-once; capability effects must be idempotent. Safety is enforced at the row level — each flow execution is held by at most one worker at a time via a time-bounded lease.

**How claims work.** Each poll cycle, `claimNext()` runs a single atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` against `flow_executions`. Postgres' `SKIP LOCKED` guarantees that concurrent workers never lock the same row, so each returned execution is owned by exactly the worker that claimed it. Expired leases (from a crashed worker) are picked up by the same query. The claim walks `flow_exec_runnable_idx` — `(created_at) WHERE status IN ('created', 'running', 'waiting')` — so its cost follows the runnable rows, not the finished history. The claim writes its states as SQL literals, because Postgres uses a partial index only when it can prove the query implies the index predicate, which it cannot do from bind parameters under a generic prepared plan. The spine claim (`opaque_dispatch_runnable_idx`) and the outbox pump (`dispatch_outbox_unpublished_idx`) follow the same rule.

**Automatic heartbeat.** While a step is running, the engine extends the lease on a timer (`flowHeartbeatIntervalMs`, default 1/3 of the lease duration). Each update checks execution ID, worker ID, claim token, running status, and an unexpired lease; tenant-placed flows first extend the same worker's opaque spine hint, then the tenant row. If either guarded update matches zero rows, ownership is lost and the worker aborts the step. Transient infrastructure failures on extend (or best-effort audit writes) are logged and retried on the next tick — they do not abort the step, surface as unhandled rejections, or permit a commit after the lease expires.

**Manual heartbeat.** Long-running step handlers that span multiple lease intervals can call `ctx.flows.heartbeat()` to extend the lease explicitly. Outside of flow execution it's a no-op, so helper code that calls it stays portable.

**`LeaseLostError`.** Thrown from `runNext` (and from `ctx.flows.heartbeat()`) when the lease has moved to another worker. If you handle it, do not write to the execution or emit events — the current lease holder is authoritative and will own the commit. In practice, workers bubble this error up to the poll loop and move on to the next row.

See [configuration](../sdk-reference/configuration.md#flow-lease-tuning) for the `flowLeaseDurationMs`, `flowHeartbeatIntervalMs`, and `flowClaimBatchSize` knobs.

## Cancellation

Inside a flow step handler, `ctx.signal` is an `AbortSignal` that fires when:

- `ctx.flows.cancel(executionId)` or `ctx.flows.terminate(executionId)` is called (in this process or any peer worker), OR
- the worker loses its lease on the execution.

`cancel` aborts the active step and runs every declared compensation for completed steps; `terminate` aborts and closes the execution without compensation. Both leave the execution in the terminal `cancelled` state, never `completed`. Audit the operator, reason, and which action was chosen in the recovery capability that calls them.

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

## Waking a delayed flow

`ctx.flows.wake(executionId)` (core 0.9.0-beta.3+) makes an execution that sleeps in a `delay` step due now. A worker claims it on its next poll and runs its next step at once instead of at the scheduled time. Use it when the reason for waiting goes away before the timer does. For example, a flow re-checks every hour whether its user has access to a resource, and the capability that grants the access wakes the executions that wait for it:

```typescript
// The administrator's capability: grant access, then let the waiting runs continue now.
handler: async (ctx, input) => {
  await ctx.data.ResourceGrant.create({ resourceId: input.resourceId, userId: input.userId });
  const waiting = await ctx.data.PendingRun.findMany({ resourceId: input.resourceId });
  for (const run of waiting) {
    await ctx.flows.wake(run.executionId); // after this transaction commits
  }
  return { waiting: waiting.length };
};
```

**What changes.** Only the due time. The execution keeps its status, current step, input, state and stored identity. The woken step runs under the identity that started the flow, never the caller's. The caller does not lend its roles to the flow and gets none of the flow's. The step is claimed and run the ordinary way, so it runs once.

**Delays only, not retry backoffs.** The pause before a failed step runs again (`retry` backoff) is a timed wait too, but `wake` leaves it alone and answers `reason: 'retry-backoff'`. The backoff is the engine's protection against a dependency that keeps failing: waking it would run the step again at once, and repeated wakes would spend every remaining attempt in seconds and fail the execution. A flow that should continue as soon as something changes waits in a `delay` step (and re-checks after it), not in a retry.

**Who may wake.** Any capability whose own `access` policy lets the caller in, for executions of the caller's own tenant. `wake` adds no role of its own: the capability is the authorization boundary, as it is for `ctx.flows.start`. The framework looks for the execution only where `start` would place one for the caller (its tenant's data plane, or the shared database), and a caller can wake only executions with its own `tenantId`. An untenanted caller can wake only untenanted executions. An execution of another tenant, an unknown id and a malformed id all get the same refusal: a `notFound` error with `metadata.reason: 'flow-execution-not-found'`. With tenant data planes and the default `untenanted: 'refuse'`, an untenanted caller is refused with `forbidden` (`reason: 'untenanted-flow-wake'`). Inside a flow step, and in a compensation, `ctx.flows.wake` is bound to the flow's own identity, like `ctx.flows.start`.

A refusal is thrown only where the call runs at once: outside a capability transaction (a query, a capability with `transactional: false`, a flow step's own `ctx.flows`). Inside a capability transaction (the default for actions and event handlers) the call answers `deferred: true` before anything is known, and the outcome after commit, a refusal included, is only logged (see below).

**Results.** Every case other than a refusal is a result, never an error, so a wake can safely race the timer or another wake:

| Result | Meaning |
| --- | --- |
| `{ woken: true, status: 'waiting' }` | This call made the delay due now. |
| `{ woken: false, reason: 'already-due' }` | The delay is already due (the timer ran out, or another wake won). A worker claims it on its next poll. The call still refreshes the wake-up hints, so calling `wake` again completes a wake whose hint update failed. |
| `{ woken: false, reason: 'wait-changed' }` | The wait ended or changed between reading the execution and waking it: a worker claimed it, it was cancelled, it moved on. |
| `{ woken: false, reason: 'not-waiting' }` | Created or running, or started in the same transaction and not committed yet. |
| `{ woken: false, reason: 'not-timed-wait' }` | Waiting for an event or an approval. Only `resume` (or the event) ends that wait. |
| `{ woken: false, reason: 'retry-backoff' }` | Waiting out a retry backoff, which `wake` never shortens. |
| `{ woken: false, reason: 'finished' }` | Completed, failed or cancelled. |
| `{ woken: false, deferred: true, status: 'pending' }` | Called inside a capability transaction. The wake runs after the transaction commits, so the step never runs before the data it waits for is visible. A rollback wakes nothing. The outcome after commit is logged through the capability's logger (`flow wake after commit` with `woken`, `reason` and `status`; `flow wake after commit failed` with the refusal's `code` and `reason`), never thrown. |

The write is fenced to the wait that was read (its generation token, the same fence `resume` uses) and to a wake time still ahead on the database clock. Of two wakes, or of a wake and the scheduled wake-up, exactly one changes the row. A wake that runs after commit is not stored durably: if the process stops between commit and wake, the execution keeps its scheduled time.

**How the wake-up is delivered.** On the shared database the execution row's `wake_at` moves to the database's `now()`, so the claim query (`wake_at <= now()`) picks it up on the next poll. With tenant data planes the execution is only claimed through its hint on the spine (the coordination database), so the wake also moves the plane's durable wait (`execution_state.wake_at`, its `wait_state`, an unpublished `dispatch_outbox` row) in the same transaction, then the spine hint's `not_before`. That holds for every tenant execution under a data-plane resolver, also when the resolver hands back the spine's own connection for the tenant. A wake that lands while the worker is still publishing the wait's hint is carried over to the new hint by that worker, and only to the wait it entered: if the execution has meanwhile woken, run and entered another delay, that delay keeps its own time. Where the engine has a Redis delayed-wake schedule or a flow-step queue (durable queue workers), the wake is published there too; both are hints that database polling recovers.

**Observability.** An engine with an audit service records `flow.woken.<flowName>` (`executionId`, `flowName`, `actor`, `tenantId`, `step`, `waitKind`, `scheduledFor`) and `flow.wake.denied` for each refusal (`executionId`, `actor`, `tenantId`, `reason`: `flow-execution-not-found` or `untenanted-flow-wake`). No input or state is recorded, and a malformed id is recorded as `(malformed)`, never as the caller's string. An engine with a logger logs each outcome. The request-side engine of `createServer` has neither, so a wake called at once returns its outcome to the capability only, and a wake deferred to commit is logged through the capability's logger. Audit the business reason (who unblocked what) in the capability that calls `wake`, as for `cancel`.

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

`auth_snapshot_json` is included in generated migrations. Current core rejects missing or invalid snapshots; recover legacy work from a verified initiating identity and never inject worker/system roles. Core 0.8 additionally requires claim tokens, wait/replay metadata, schedule definitions/ticks, and pending job dispatch fields. The older lease-column preflight does not replace the [full stabilization migration](../upgrading-stabilization.md).

## Operations: claim indexes and retention of finished rows

Since core 0.9.0-beta.5 the framework tables carry indexes that match their claim queries exactly, plus the indexes the retention sweep scans:

| Table | Index | Used by |
|-------|-------|---------|
| `flow_executions` | `flow_exec_runnable_idx (created_at) WHERE status IN ('created', 'running', 'waiting')` | `claimNext` |
| `flow_executions` | `flow_exec_finished_idx (updated_at) WHERE status IN ('completed', 'cancelled')` | retention |
| `flow_schedule_ticks` | `flow_schedule_ticks_created_idx (created_at)` | retention |
| `job_executions` | `job_exec_dispatch_pending_idx (dispatch_after) WHERE dispatch_pending = true AND status = 'queued'` | pending job publication |
| `core_plumbus.dispatch_outbox` | `dispatch_outbox_unpublished_idx (created_at) WHERE published_at IS NULL AND spine_acked_at IS NULL AND superseded = false` | outbox pump |
| `core_plumbus.dispatch_outbox` | `dispatch_outbox_spine_row_idx (spine_row_id) WHERE spine_acked_at IS NULL` | closing the row behind an acknowledged hint |
| `core_plumbus.dispatch_outbox` | `dispatch_outbox_acked_idx (created_at) WHERE spine_acked_at IS NOT NULL` | retention |
| `core_plumbus.execution_state` | `execution_state_terminal_idx (updated_at) WHERE terminal = true` | retention |
| `core_plumbus.side_effect_log` | `side_effect_log_applied_idx (applied_at)` | retention |
| `opaque_dispatch` (spine) | `opaque_dispatch_runnable_idx (created_at) WHERE delivery_state IN ('ready', 'retry-scheduled', 'leased')` | spine claim |
| `opaque_dispatch` (spine) | `opaque_dispatch_execution_idx (execution_id, created_at)` | finding an execution's plane |
| `opaque_dispatch` (spine) | `opaque_dispatch_acked_idx (created_at) WHERE delivery_state = 'acknowledged'` | retention |

The tables in the app's schema reach it like every framework table change: `plumbus migrate generate` emits one `CREATE INDEX IF NOT EXISTS` per index, `plumbus migrate apply` runs them on every database the app migrates (the spine and each tenant plane). `opaque_dispatch` is not in app migrations: apply `migrations/spine/0002_claim_and_retention_indexes.sql` on the spine (hosts that provision `core_plumbus` from the shipped journal also apply `migrations/durable-tenant/0004_claim_and_retention_indexes.sql`). `CREATE INDEX` without `CONCURRENTLY` blocks writes to the table while it builds; on a large table create the same indexes `CONCURRENTLY` by hand first, and the migration's `IF NOT EXISTS` statements then do nothing. The existing single-column indexes stay: the scheduler's overlap check reads `flow_name` / `tenant_id`, and resuming by event reads `status`.

**Retention (opt-in).** Finished framework rows are never deleted unless the worker pool is given `frameworkRetention`. Export it from `app/server.ts` (`plumbus start`, `plumbus worker`, `plumbus dev`), or pass it to `createWorkerPool`:

```ts
export const frameworkRetention = { keepDays: 30 }; // or `true` for every default
```

| Option | Default | Meaning |
|--------|---------|---------|
| `keepDays` | `30` (at least 1) | Rows stay this long after they finished |
| `batchSize` | `500` | Rows per `DELETE` |
| `maxBatchesPerTable` | `20` | Statements per table per run; a larger backlog continues on the next run |
| `intervalMs` | one hour | How often the pool runs it (first run a minute after start) |

Each run, with the flow runner, covers the pool's database, the spine and every tenant plane the pool lists (`listTenantRefs` plus planes it resolved), one plane at a time, each `DELETE` locking its batch with `FOR UPDATE SKIP LOCKED`. It deletes:

- `flow_executions` rows `completed` or `cancelled` before the window — not while a `flow_start_intents` row or non-terminal durable state exists for the same id;
- terminal `execution_state` rows that `succeeded` or were `cancelled`, with their `step_execution`, `wait_state`, `terminal_state` and `dispatch_outbox` rows and their acknowledged spine hints;
- acknowledged `dispatch_outbox` rows; `side_effect_log` rows (each key is fenced by the revision it was applied under);
- `flow_schedule_ticks` behind their schedule's `next_run_at` (a tick at or after it is the slot dedupe the scheduler relies on);
- on the spine, acknowledged hints a later revision of the same execution replaced. The newest hint of an execution stays until its tenant state is pruned: a request-side engine finds the plane through it.

It never deletes `failed` executions or their durable state (operator retry and replay need them), `flow_dead_letter` rows, unacknowledged outbox rows, hints that are not acknowledged, audit records, or the event and job tables. A deleted execution is no longer found by `ctx.flows.status`; keep `keepDays` above the longest time anything reads an execution after it finished. `pruneFrameworkTables(db, options)` and `pruneSpineDispatchHints(spineDb, options)` run one pass yourself; both skip tables a database does not have.

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
plumbus flow dead-letter retry <executionId> [--actor <id>] [--in-place]
```

`retry` creates a new execution at the failed step using the original verified caller and saved state. The source remains terminal; repeated requests reuse its recorded replay ID. The replay keeps the source's compiled-definition pin, and the dead letter records `replayedBy` (the `--actor`, defaulting to `$USER`). `--in-place` instead resets the same execution to `created` at the failed step and records `retriedBy`; it is refused once the dead letter was replayed or already retried. A sweeper recovers missing dead-letter snapshots. External effects must be idempotent.

### Programmatic API

```typescript
import { sweepFailedFlows, deadLetterFlow, retryDeadLetteredFlow } from "@plumbus/core";

// Manually dead-letter a failed flow
await deadLetterFlow(db, executionId);

// Reset a dead-lettered execution in place (what `retry --in-place` does)
await retryDeadLetteredFlow(db, executionId, { actor: "ops-user", reason: "fixed upstream" });

// Sweep all failed flows past retry limit
await sweepFailedFlows(db);
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


Legacy executions without a valid auth snapshot now fail before step execution. Restart them with a verified initiating identity after reviewing the execution's prior side effects. Snapshot parsing requires roles, scopes, and provider plus matching actor/tenant fields; the worker identity is never a fallback. New snapshots omit session IDs and authentication timestamps.


## Core 0.8 stabilization

See [the upgrade guide](../upgrading-stabilization.md) before migration. Retry waits persist deadlines and release claims. Legacy `retry.attempts: N` retains N retries after the first call; `maxAttempts` counts total calls, and aliases cannot be combined. Budgets reset on successful advancement. Cancellation clears the claim token and prevents in-flight commits; external effects already started may still complete.

Schedules support `firstRun: 'immediate' | 'next'`, `overlap: 'allow' | 'skip'`, and IANA `timezone`. Defaults preserve immediate initial execution, allowed overlap and local time. Scheduled input is `{}`. Core owns cron-parser. Startup seeds the initial schedule set; `plumbus flow schedule sync` previews reconciliation and `--apply --expected-revision <revision>` applies a complete deployment manifest. Tick/execution creation and timing updates share a database transaction. Redis wakes are recoverable hints.

Automatic flow dead letters copy the final attempt/history; a sweeper recovers failed copies. CLI retry creates a new execution from the failed step and preserves the source terminal record and caller identity. `ctx.jobs.enqueue()` is wired for flow capabilities and transactionally persists dispatch intent. With a worker data-plane resolver, flow steps that run on a resolved tenant plane do not have a job queue yet (`enqueue` throws); see [Tenant Data Planes](../sdk-reference/tenant-data-planes.md). See the upgrade guide for cutover, retry, replay, and publication guarantees.
