# Events

Events represent domain facts that have occurred. They are emitted by capabilities and consumed by event handlers or flow triggers.

## Defining an Event

```ts
import { defineEvent } from "plumbus-core";
import { z } from "zod";

export const orderPlaced = defineEvent({
  name: "order.placed",
  domain: "orders",
  version: "1.0.0",

  payload: z.object({
    orderId: z.string(),
    customerId: z.string(),
    amount: z.number(),
    items: z.array(z.object({ productId: z.string(), quantity: z.number() })),
  }),
});
```

## Naming Convention

Use `<domain>.<past-tense-verb>` format: `order.placed`, `refund.requested`, `user.updated`, `invoice.paid`.

## Emission

Events are emitted inside capability handlers via `ctx.events.emit`:

```ts
handler: async (ctx, input) => {
  const order = await ctx.data.Order.create(input);
  await ctx.events.emit("order.placed", {
    orderId: order.id,
    customerId: input.customerId,
    amount: input.total,
    items: input.items,
  });
  return { orderId: order.id };
}
```

## Outbox Pattern

Events are **not** dispatched immediately. They are written to an outbox table in the **same database transaction** as the capability's data changes. This guarantees at-least-once delivery with no data/event inconsistency.

A background dispatcher polls the outbox and publishes events to the queue system for delivery.

## Event Envelope

When delivered, each event is wrapped in an envelope:

```ts
{
  id: "evt_abc123",           // Unique event ID
  eventType: "order.placed",  // Event name
  version: "1.0.0",           // Schema version
  occurredAt: Date,           // When it happened
  actor: "usr_456",           // Who caused it
  tenantId: "tnt_789",        // Tenant scope
  correlationId: "corr_xyz",  // Request correlation
  causationId: "evt_prev",    // Causing event (if chained)
  payload: { ... }            // Typed payload
}
```

## Consuming Events

Events are consumed by capabilities with `kind: "eventHandler"`:

```ts
export const onOrderPlaced = defineCapability({
  name: "onOrderPlaced",
  kind: "eventHandler",
  domain: "fulfillment",
  // ...
  handler: async (ctx, event) => {
    // event is the typed payload
    await ctx.data.Shipment.create({ orderId: event.orderId });
  },
});
```

## Idempotency

Consumers should be idempotent — processing the same event twice must produce the same result. The framework tracks delivered event+consumer pairs to support this.

## Versioning

Include `version` in event definitions. When schemas evolve, bump the version. Consumers can specify version constraints.
