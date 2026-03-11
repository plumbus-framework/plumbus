# Patterns & Conventions

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Capability | camelCase verb+noun | `getUser`, `approveRefund`, `processPayment` |
| Entity | PascalCase noun | `User`, `Order`, `InvoiceLine` |
| Event | domain.pastTense | `order.placed`, `refund.requested`, `user.updated` |
| Flow | camelCase noun | `refundApproval`, `orderFulfillment` |
| Prompt | camelCase verb+noun | `summarizeTicket`, `classifyIntent` |
| Domain | lowercase singular | `users`, `billing`, `fulfillment` |

## File Structure

```
app/capabilities/<domain>/<name>/
  capability.ts     # defineCapability() — contract only
  impl.ts           # handler implementation (optional split)
  tests/
    <name>.test.ts
    fixtures/

app/flows/<domain>/<name>/
  flow.ts
  tests/

app/entities/<name>.entity.ts
app/events/<name>.event.ts
app/prompts/<name>.prompt.ts
```

## Do's

- **Do** declare all side effects in `effects`. Governance relies on this.
- **Do** add `classification` to every entity field that contains user data.
- **Do** use `maskedInLogs: true` for passwords, tokens, and keys.
- **Do** keep handlers thin — delegate complex logic to helper functions.
- **Do** use `ctx.errors.*` for all error conditions (not raw `throw new Error`).
- **Do** write tests using `runCapability` and `simulateFlow` test utilities.
- **Do** use the outbox pattern for events — always emit via `ctx.events.emit`.
- **Do** add `tenantScoped: true` to entities that require multi-tenant isolation.

## Don'ts

- **Don't** access the database directly — always use `ctx.data.<Entity>`.
- **Don't** emit events outside of capabilities — the outbox pattern requires a capability transaction.
- **Don't** bypass `ctx.auth` checks — the framework evaluates access policies before your handler runs.
- **Don't** mutate the `ctx` object — it is scoped and controlled by the framework.
- **Don't** import framework internals — use only the public SDK surface (`defineCapability`, `defineFlow`, etc.).
- **Don't** store secrets in code — use `ctx.config` and environment variables.
- **Don't** edit files in `.plumbus/generated/` — they are regenerated on every build.
- **Don't** create capabilities without access policies (governance will warn).

## Common Patterns

### CRUD Capability Set

For a typical entity, create four capabilities:

```ts
// app/capabilities/users/getUser/capability.ts
defineCapability({ name: "getUser", kind: "query", ... });

// app/capabilities/users/createUser/capability.ts
defineCapability({ name: "createUser", kind: "action", ... });

// app/capabilities/users/updateUser/capability.ts
defineCapability({ name: "updateUser", kind: "action", ... });

// app/capabilities/users/deleteUser/capability.ts
defineCapability({ name: "deleteUser", kind: "action", ... });
```

### Event-Driven Side Effects

Instead of calling multiple services in one capability, emit events and let handlers react:

```ts
// Capability: createOrder
handler: async (ctx, input) => {
  const order = await ctx.data.Order.create(input);
  await ctx.events.emit("order.placed", { orderId: order.id });
  return { orderId: order.id };
}

// Separate event handlers react independently:
// onOrderPlaced → create shipment
// onOrderPlaced → send confirmation email
// onOrderPlaced → update analytics
```

### AI-Augmented Capability

```ts
handler: async (ctx, input) => {
  const classification = await ctx.ai.classify({
    labels: ["billing", "technical", "general"],
    text: input.message,
  });
  const ticket = await ctx.data.Ticket.create({
    ...input,
    category: classification[0],
  });
  return { ticketId: ticket.id, category: classification[0] };
}
```
