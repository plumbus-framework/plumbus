# Flows

A flow is a multi-step workflow that orchestrates capabilities in sequence, with support for branching, parallel execution, waits, and delays.

## Defining a Flow

```ts
import { defineFlow } from "plumbus-core";
import { z } from "zod";

export const refundApproval = defineFlow({
  name: "refundApproval",
  domain: "billing",

  input: z.object({ refundId: z.string(), amount: z.number() }),
  state: z.object({ approved: z.boolean().default(false) }),

  steps: [
    { type: "capability", name: "validateRefund" },
    { type: "conditional", name: "checkAmount", if: "amount > 100", then: "managerApproval", else: "autoApprove" },
    { type: "wait", name: "managerApproval", event: "refund.approved" },
    { type: "capability", name: "autoApprove" },
    { type: "capability", name: "processRefund" },
    { type: "eventEmit", name: "notifyCustomer", event: "refund.completed" },
  ],

  trigger: { event: "refund.requested" },
  retry: { attempts: 3, backoff: "exponential" },
});
```

## Step Types

| Type | Purpose | Key Fields |
|------|---------|-----------|
| `capability` | Execute a named capability | `name` (capability name) |
| `conditional` | Branch based on condition | `if`, `then`, `else` |
| `wait` | Pause until event or timeout | `event` |
| `delay` | Pause for a fixed duration | `duration` (e.g., `"24h"`, `"5m"`) |
| `parallel` | Run multiple steps concurrently | `branches` (step names) |
| `eventEmit` | Emit a framework event | `event` (event type) |
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
schedule: { cron: "0 9 * * MON" }   // Every Monday at 9 AM
```

### Manual
```ts
// From a capability handler:
await ctx.flows.start("refundApproval", { refundId: "rf_123", amount: 150 });
```

## Retry Policy

```ts
retry: {
  attempts: 3,        // Max retry attempts per failed step
  backoff: "exponential"  // "exponential" or "fixed"
}
```

Steps that fail with transient errors are retried. Permanent failures stop the flow and move it to the dead-letter queue.

## Flow Lifecycle

`created → running → waiting → running → completed | failed`

- Steps execute sequentially (except `parallel`)
- Every step produces an audit record
- Failed flows with exhausted retries land in a dead-letter queue for manual inspection
