# Events

Events represent **domain facts** — things that have happened in the system. They enable loose coupling between capabilities through the publish-subscribe pattern.

## Defining an Event

```typescript
import { defineEvent } from "plumbus-core";
import { z } from "zod";

export const orderPlaced = defineEvent({
  name: "order.placed",
  schema: z.object({
    orderId: z.string().uuid(),
    customerId: z.string().uuid(),
    total: z.number().positive(),
    items: z.array(z.object({
      productId: z.string(),
      quantity: z.number(),
    })),
  }),
  description: "Emitted when a new order is successfully placed",
});
```

## Naming Convention

Events follow the `domain.pastTense` pattern:

```
order.placed
refund.requested
refund.approved
user.created
user.updated
payment.failed
shipment.dispatched
```

## Emitting Events

Events are emitted inside capability handlers via `ctx.events.emit()`:

```typescript
handler: async (ctx, input) => {
  const order = await ctx.data.Order.create(input);

  await ctx.events.emit("order.placed", {
    orderId: order.id,
    customerId: input.customerId,
    total: input.total,
    items: input.items,
  });

  return { orderId: order.id };
}
```

## The Outbox Pattern

Events are guaranteed to be delivered through the **outbox pattern**:

```
┌──────────────────────────────────────────────────┐
│            Single Database Transaction            │
│                                                  │
│  INSERT INTO orders (...)        ← data write    │
│  INSERT INTO outbox_events (...) ← event record  │
│                                                  │
│         Both succeed or both rollback             │
└───────────────────────┬──────────────────────────┘
                        │
                        │ After transaction commits
                        ▼
              ┌──────────────────┐
              │ Outbox Dispatcher│ ← Polls for pending events
              │ (background)     │
              └────────┬─────────┘
                       │
              ┌────────▼─────────┐
              │   Event Queue    │ ← Redis or in-memory
              └────────┬─────────┘
                       │
              ┌────────▼─────────┐
              │   Consumers      │
              └──────────────────┘
```

This guarantees **at-least-once delivery** — events are never lost even if the application crashes.

## Event Envelope

Every event is wrapped in an envelope with metadata:

```typescript
interface EventEnvelope {
  id: string;               // Unique event ID
  eventType: string;        // "order.placed"
  payload: unknown;         // Event data
  tenantId?: string;        // Tenant context
  actor: string;            // Who triggered it
  correlationId: string;    // Request trace ID
  occurredAt: Date;         // When it happened
}
```

## Consuming Events

### Via Event Handler Capability

```typescript
defineCapability({
  name: "onOrderPlaced",
  kind: "eventHandler",
  domain: "shipping",
  // ...
  access: { serviceAccounts: ["event-worker"] },
  handler: async (ctx, input) => {
    await ctx.data.Shipment.create({
      orderId: input.orderId,
      status: "pending",
    });
  },
});
```

### Via Consumer Registry

```typescript
const registry = new ConsumerRegistry();
registry.register("order.placed", async (envelope) => {
  // Process the event
});
```

## Idempotency

The event worker includes built-in idempotency to handle duplicate deliveries:

```
Event arrives
    │
    ▼
┌───────────────────┐
│ Check idempotency │
│ table for eventId │
└─────────┬─────────┘
          │
    ┌─────┼─────┐
    │ seen      │ not seen
    │           │
    ▼           ▼
  Skip     Process event
            then record eventId
```

The idempotency service uses a dedicated database table to track processed event IDs.

## Event Queue Options

### In-Memory Queue

```typescript
import { createInMemoryQueue } from "plumbus-core";

const queue = createInMemoryQueue();
```

Best for: development, testing, single-instance deployments.

### Redis Queue

```typescript
import { createRedisQueue } from "plumbus-core";

const queue = createRedisQueue({
  host: "localhost",
  port: 6379,
  queueName: "plumbus-events",
});
```

Best for: production, multi-instance deployments.

## Dead Letter Queue

Events that fail processing after all retries are moved to the dead letter table:

```
Event fails processing
    │
    ▼
Retry (1, 2, 3...)
    │
    ▼ exhausted
Dead Letter Table
    │
    ├─ eventType
    ├─ payload
    ├─ error message
    ├─ failedAt
    └─ original envelope
```

## File Convention

```
app/events/
├── order-placed.event.ts
├── refund-requested.event.ts
└── user-created.event.ts
```

