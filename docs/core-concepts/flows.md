# Flows

Flows orchestrate multiple capabilities into **structured, multi-step workflows**. They support sequential execution, conditional branching, parallel processing, event-driven waits, and automatic retries.

## Defining a Flow

```typescript
import { defineFlow } from "@plumbus/core";

export const orderFulfillment = defineFlow({
  name: "orderFulfillment",
  domain: "orders",
  description: "Process an order from payment to delivery",
  trigger: { type: "event", event: "order.placed" },
  steps: [
    { name: "validateOrder", capability: "validateOrder" },
    { name: "processPayment", capability: "processPayment" },
    {
      name: "checkInventory",
      type: "conditional",
      condition: "ctx.state.paymentStatus === 'success'",
      ifTrue: "createShipment",
      ifFalse: "cancelOrder",
    },
    { name: "createShipment", capability: "createShipment" },
    { name: "cancelOrder", capability: "cancelOrder" },
    {
      name: "notifyAll",
      type: "parallel",
      branches: ["sendEmail", "sendSms", "updateDashboard"],
    },
    { name: "sendEmail", capability: "sendOrderEmail" },
    { name: "sendSms", capability: "sendOrderSms" },
    { name: "updateDashboard", capability: "updateOrderDashboard" },
  ],
  retry: { maxAttempts: 3, backoff: "exponential" },
});
```

## Step Types

### Capability Step

Executes a capability:

```typescript
{ name: "validateOrder", capability: "validateOrder" }
```

By default, each capability step receives the **merged flow input + flow state** as its input. You can also provide explicit `input` overrides with template references:

```typescript
{
  name: "extractEvents",
  capability: "extractTimelineEvents",
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
  condition: "ctx.state.amount > 100",
  ifTrue: "managerApproval",
  ifFalse: "autoApprove",
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
  timeout: "24h",
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

## Triggers

| Trigger Type | Configuration | When It Fires |
|-------------|--------------|--------------|
| `event` | `{ type: "event", event: "order.placed" }` | When the named event is emitted |
| `scheduled` | `{ type: "scheduled", cron: "0 0 * * *" }` | On cron schedule |
| `manual` | `{ type: "manual" }` | Via `ctx.flows.start()` or API call |

## Retry Policy

```typescript
retry: {
  maxAttempts: 3,
  backoff: "exponential",  // "fixed" | "exponential" | "linear"
  initialDelay: 1000,      // ms
  maxDelay: 60000,          // ms
}
```

Retry behavior:
- `fixed`: same delay between each retry
- `linear`: delay increases linearly (1s, 2s, 3s...)
- `exponential`: delay doubles (1s, 2s, 4s, 8s...)

## Multi-Worker Safety & Leasing

Plumbus is built for horizontal scale: any number of worker processes can share one database without executing the same step twice. Safety is enforced at the row level — each flow execution is held by at most one worker at a time via a time-bounded lease.

**How claims work.** Each poll cycle, `claimNext()` runs a single atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` against `flow_executions`. Postgres' `SKIP LOCKED` guarantees that concurrent workers never lock the same row, so each returned execution is owned by exactly the worker that claimed it. Expired leases (from a crashed worker) are picked up by the same query.

**Automatic heartbeat.** While a step is running, the engine extends the lease on a timer (`flowHeartbeatIntervalMs`, default 1/3 of the lease duration). Each tick issues a `UPDATE … WHERE id = $1 AND lease_owner = $workerId`; if zero rows match, the lease has been stolen and the worker aborts the step.

**Manual heartbeat.** Long-running step handlers that span multiple lease intervals can call `ctx.flows.heartbeat()` to extend the lease explicitly. Outside of flow execution it's a no-op, so helper code that calls it stays portable.

**`LeaseLostError`.** Thrown from `runNext` (and from `ctx.flows.heartbeat()`) when the lease has moved to another worker. If you handle it, do not write to the execution or emit events — the current lease holder is authoritative and will own the commit. In practice, workers bubble this error up to the poll loop and move on to the next row.

See [configuration](../sdk-reference/configuration.md#flow-lease-tuning) for the `flowLeaseDurationMs`, `flowHeartbeatIntervalMs`, and `flowClaimBatchSize` knobs.

## Flow State Machine

```
                ┌─────────┐
                │ pending │
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
  stepName: "processPayment",
  status: "completed",       // "completed" | "failed" | "skipped"
  startedAt: Date,
  completedAt: Date,
  output: { paymentId: "pay_123" },
}
```

The full history is accessible for debugging and audit.

## Dead Letter

Failed flows that exhaust retries are sent to the dead letter queue:

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

