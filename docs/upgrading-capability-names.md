# Upgrading to canonical capability names

Plumbus registers and references capabilities by **canonical name**: `<domain>.<capabilityName>`.

The local `name` field in `defineCapability` stays a short identifier (`approveRefund`). The framework derives `billing.approveRefund` from `domain: "billing"` + `name: "approveRefund"`.

## What to update

1. **Flow steps** — `step.capability` values:

   ```typescript
   // Before
   { type: "capability", capability: "validateOrder" }

   // After
   { type: "capability", capability: "orders.validateOrder" }
   ```

2. **`effects.capabilities`** — declared invoke dependencies:

   ```typescript
   effects: {
     data: ["Order"],
     events: [],
     external: [],
     capabilities: ["billing.getInvoice"],
     ai: false,
   }
   ```

3. **Handler code** — `ctx.capabilities.invoke`:

   ```typescript
   await ctx.capabilities.invoke("billing.chargeCard", { amount: input.total });
   ```

4. **Tests and fixtures** — any hard-coded capability name strings passed to registries, flow simulation, or mocks.

5. **Regenerate** — run `plumbus generate` so `RegisteredCapabilityName`, `manifest.json`, and `capability-graph.md` use canonical names.

## Verification

Run `plumbus verify` — the `architecture.non-canonical-capability-reference` rule flags flow steps and `effects.capabilities` entries that lack a domain prefix.

## Invocation policy

- Direct handler imports are forbidden (advisory `architecture.direct-capability-handler-import` in verify).
- Undeclared `ctx.capabilities.invoke` calls fail at runtime with `dependencyViolation`.
- Job capabilities cannot be synchronous invoke targets.
- `simulateFlow` uses the same job-blocking step executor as production when you pass `capabilities` in test options.

`executeCapability` is exported from `@plumbus/core` for framework wiring, tests, and flow/MCP runtimes. Application capability modules should use `ctx.capabilities.invoke` inside handlers — not `executeCapability` directly.

See [capabilities](./core-concepts/capabilities.md#capability-to-capability-invocation) for the full policy.
