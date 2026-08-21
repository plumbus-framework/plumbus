# Events

Events represent **domain facts** — things that have happened in the system. They enable loose coupling between capabilities through the publish-subscribe pattern.

## Defining an Event

```typescript
import { defineEvent } from "@plumbus/core";
import { z } from "zod";

export const orderPlaced = defineEvent({
  name: "order.placed",
  payload: z.object({
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

Events are emitted inside capability handlers via `ctx.events.emit()`. Hosts that should not assemble the emitter per call use `createPlumbusRuntime({ events: emitter }).publishEvent(...)`. Subscriptions and the outbox pump wrap the existing consumer registry and dispatcher — not a second bus. See [Execution lifecycle — Host runtime facade](../architecture/execution-lifecycle.md#host-runtime-facade).

```typescript
await runtime.publishEvent("example.accepted", { orderId });
runtime.subscribe({
  id: "example.record",
  eventTypes: ["example.accepted"],
  handler: async (envelope) => { /* ... */ },
});
await runtime.pumpEvents();
```

Capability handlers still use `ctx.events.emit()`:

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

### Type-Safe Event Emission

After running `plumbus generate`, the `emit()` call is fully type-safe — both the event name and the payload are checked at compile time:

```typescript
// Generated in .plumbus/generated/plumbus.d.ts:
// eventPayloads: {
//   "order.placed": { orderId: string; customerId: string; total: number; items: ... };
// };

// ✅ Correct — payload matches the schema
await ctx.events.emit("order.placed", { orderId: "abc", customerId: "xyz", total: 100, items: [] });

// ❌ Type error — missing required fields
await ctx.events.emit("order.placed", { wrong: "field" });

// ❌ Type error — "no.such.event" is not a registered event name
await ctx.events.emit("no.such.event", {});
```

Before generation, both parameters fall back to `string` and `unknown` for backward compatibility.

## The Outbox Pattern

Events are guaranteed to be delivered through the **outbox pattern**:

```
┌──────────────────────────────────────────────────┐
│            Single Database Transaction            │
│                                                  │
│  INSERT INTO orders (...)        ← data write    │
│  INSERT INTO event_outbox (...) ← event record  │
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
interface EventEnvelope<TPayload = unknown> {
  id: string;               // Unique event ID
  eventType: string;        // "order.placed"
  version: string;          // Event schema version (from `defineEvent({ version })`, defaults to "1")
  occurredAt: Date;         // When it happened
  actor: string;            // Who triggered it (userId, service account, "system", etc.)
  tenantId?: string;        // Tenant context, if scoped
  correlationId: string;    // Request trace ID — same across the full request graph
  causationId?: string;     // Caller capability canonical name when emitted during nested invoke, or parent event/request id
  payload: TPayload;        // Event data, typed to the schema declared in `defineEvent`
}
```

## Consuming Events

### Via Event Handler Capability

Declare `trigger.event` on the capability contract. At worker startup, Plumbus auto-registers the handler as a queue consumer — no manual `ConsumerRegistry` wiring required.

```typescript
defineCapability({
  name: "onOrderPlaced",
  kind: "eventHandler",
  domain: "shipping",
  trigger: { event: "order.placed" },
  input: orderPlaced.payload, // reusing the event payload schema validates the envelope payload
  access: { serviceAccounts: ["event-worker"] },
  handler: async (ctx, input) => {
    await ctx.data.Shipment.create({
      orderId: input.orderId,
      status: "pending",
    });
  },
});
```

`plumbus verify` warns when an `eventHandler` lacks `trigger.event` (`worker.event-handler-missing-trigger`). Manual `ConsumerRegistry` registrations with the same consumer id take precedence over auto-registration.

### Via Consumer Registry

```typescript
const registry = new ConsumerRegistry();
registry.register({
  id: "shipping-on-order-placed",
  eventTypes: ["order.placed"],
  handler: async (envelope) => {
    // Process the event
  },
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

The runtime resolves three shared queues — `events`, `flows`, and `jobs` — through `resolveRuntimeQueues()`. You rarely instantiate queues manually; `plumbus dev`, `plumbus start`, and `plumbus worker` wire them automatically.

| Backend | When selected | Best for |
|---------|---------------|----------|
| In-memory | `plumbus dev` (always), or production without Redis | Development, single-instance |
| Redis | `QUEUE_URL` / `REDIS_URL` set, non-default host, or `QUEUE_BACKEND=redis` | Production, split API + worker |

Install the optional `redis` peer dependency for durable queues:

```bash
pnpm add redis
```

See [Workers and Queues](../architecture/workers-and-queues.md) for runtime modes and `PLUMBUS_RUNTIME_ROLE`.

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

### Operational CLI

```bash
plumbus events status                        # backlog + DLQ count
plumbus events dead-letter list [--limit 20]
plumbus events dead-letter retry <id>        # re-publish to events queue
plumbus events replay <eventId>              # re-dispatch from outbox (trusted replay actor)
plumbus events replay <eventId> --from 2026-01-01T00:00:00Z  # bulk replay
```

## File Convention

```
app/events/
├── order-placed.event.ts
├── refund-requested.event.ts
└── user-created.event.ts
```

---

## SDK reference

For every `defineEvent` option (`domain`, `version`, `tags`) and the full `EventEnvelope` shape, see [SDK Reference → defineEvent](../sdk-reference/define-functions.md#defineevent). This page covers the common case; the reference is exhaustive.

