# Events

Events represent domain facts that have occurred. They are emitted by capabilities and consumed by event handlers or flow triggers.

## Defining an Event

```ts
import { defineEvent } from "@plumbus/core";
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

For `action` / `eventHandler` capabilities this is the default (**transactional outbox ON**). Opt out with `execution.transactionalOutbox: false`, `PLUMBUS_TRANSACTIONAL_OUTBOX=false`, or per-capability `transactional: false`. Auto-excluded: `kind: 'job'`, `effects.ai: true`, non-empty `effects.external`. See `capabilities.md` § Transactional outbox.

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
  trigger: { event: "order.placed" }, // auto-registers at worker startup (0.5+)
  // ...
  handler: async (ctx, event) => {
    // event is the typed payload
    await ctx.data.Shipment.create({ orderId: event.orderId });
  },
});
```

### Auto-registration (`trigger.event`)

From **0.5.0**, set `trigger: { event: "<event.name>", versionConstraint?: "..." }` on `eventHandler` capabilities. The worker pool registers a queue consumer automatically — no manual `ConsumerRegistry` entry required.

- **Manual registration still works** and takes precedence when the consumer id equals the capability name.
- **`plumbus verify`** and **`plumbus doctor`** warn when `eventHandler` capabilities omit `trigger.event` (advisory).
- **`trigger` is only valid on `kind: "eventHandler"`** — other kinds throw at define time.

Dequeue uses tenant binding from the `event_outbox` row (fail-closed). Do not push forged messages to Redis; use `plumbus events replay` or `plumbus events dead-letter retry` for operational recovery.

## Idempotency

Consumers should be idempotent — processing the same event twice must produce the same result. The framework tracks delivered event+consumer pairs to support this.

## Versioning

Include `version` in event definitions. When schemas evolve, bump the version. Consumers can specify version constraints.
