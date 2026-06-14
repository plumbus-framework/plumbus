# Upgrading to 0.5 — Capability Invocation

Use this playbook when upgrading `@plumbus/core` to **0.5.x** and fixing existing app code. For workers, queues, and job HTTP behavior, also read `node_modules/@plumbus/core/instructions/deployment.md` (Upgrading to 0.5).

## What changed

Plumbus **0.5.0** enforces:

- **Canonical capability names** — `<domain>.<name>` everywhere except the short `name` field inside `defineCapability`.
- **Declared invoke dependencies** — `effects.capabilities` + `ctx.capabilities.invoke` (no direct handler imports).
- **Flow step auth snapshot** — user-triggered flows keep the caller's roles; no implicit `system` elevation on every step.
- **Job blocking** — `kind: 'job'` capabilities cannot run synchronously in flow steps or via `ctx.capabilities.invoke`.

The local `name` in `defineCapability` stays short (`approveRefund`). The framework derives `billing.approveRefund` from `domain: "billing"` + `name: "approveRefund"`.

---

## 1. Canonical capability names

Update every **reference** string (not the `name` field in `defineCapability`):

| Location | Before | After |
|----------|--------|-------|
| Flow step | `capability: "validateOrder"` | `capability: "orders.validateOrder"` |
| `effects.capabilities` | `["getInvoice"]` | `["billing.getInvoice"]` |
| `ctx.capabilities.invoke` | `"chargeCard"` | `"billing.chargeCard"` |
| Tests / mocks | short names | canonical names |
| MCP tool names (manifest) | short names | canonical names (after `plumbus generate`) |

Search the codebase for hard-coded capability strings in:

- `app/flows/**` — `step.capability`
- `app/capabilities/**` — `effects.capabilities`, `ctx.capabilities.invoke`
- Tests — registries, `simulateFlow`, `runCapability`, mocks
- Generated artifacts — refresh with `plumbus generate` (see step 5)

---

## 2. `effects.capabilities` + `ctx.capabilities.invoke`

Replace direct handler imports and `.handler` calls with the sanctioned invoke path:

```ts
// Before — forbidden
import { getInvoice } from "../billing/get-invoice/index.js";
await getInvoice.handler(ctx, { invoiceId });

// After
effects: {
  data: ["Invoice"],
  events: [],
  external: [],
  capabilities: ["billing.getInvoice"],
  ai: false,
},
handler: async (ctx, input) => {
  const invoice = await ctx.capabilities.invoke("billing.getInvoice", {
    invoiceId: input.invoiceId,
  });
  return { invoice };
},
```

Rules:

- Every `ctx.capabilities.invoke` target must appear in `effects.capabilities` (canonical names).
- Undeclared calls, cycles, missing targets → runtime `dependencyViolation` (`400`).
- `plumbus verify` flags direct handler imports (`architecture.direct-capability-handler-import`).
- Handler-visible `ctx.__runtime` no longer exposes internal invokers — use `ctx.capabilities.invoke` only.
- `executeCapability` is for framework wiring and tests, not app handlers.

---

## 3. Flow `step.capability` format

Flow steps must use canonical names:

```ts
steps: [
  { type: "capability", name: "validate", capability: "orders.validateOrder" },
  { type: "capability", name: "charge", capability: "billing.chargeCard" },
]
```

Flow steps are **not** subject to a parent capability's `effects.capabilities` — only handler-to-handler `invoke` requires declared dependencies.

---

## 4. Flow auth snapshot

**Breaking:** user-triggered flows no longer auto-inject the `system` role on every step.

When a flow starts, the framework stores the caller's full `AuthContext` in `flow_executions.auth_snapshot_json` and restores it on each step. Step capabilities must allow the **original caller's** roles/scopes (or `public`) — not rely on implicit `system` elevation.

```ts
// Fix access policies on capabilities called from user-triggered flows
access: {
  roles: ["admin", "billing"],  // include roles the HTTP/API caller actually has
  tenantScoped: true,
},
```

Scheduled and worker-owned flows still run under explicit `system` auth from the scheduler/worker bootstrap.

If steps suddenly return **403** after upgrade, check `access.roles` on step targets — add the caller's roles or mark `public: true` where appropriate.

---

## 5. Job capabilities blocked in flows and invoke

`kind: 'job'` capabilities cannot run synchronously:

- **Flow steps** — step executor returns `dependencyViolation`.
- **`ctx.capabilities.invoke`** — same error at runtime.

Use job dispatch (`POST` → **202** + poll `GET /api/jobs/:jobId`), events, or async `eventHandler` consumers instead.

---

## 6. MCP tool names

After renaming references, run `plumbus generate` so `mcp-manifest.json` and skill files use canonical tool names (`billing.approveRefund`, not `approveRefund`). Update any agent configs or integration tests that assert tool names.

---

## Migration commands

Run from the project root in this order:

```bash
# 1. Fix source strings (canonical names, effects, invoke, access.roles) — see checklist below

# 2. Regenerate types and manifests
plumbus generate

# 3. Verify architecture rules
plumbus verify

# 4. Database — job_executions + flow auth_snapshot_json (if upgrading from pre-0.5)
plumbus migrate generate && plumbus migrate apply
```

Apply migrations **before** production traffic. The migration adds `auth_snapshot_json` on `flow_executions` (and `job_executions` for job queue auth). Rows created before the column exists fall back to worker auth for roles until migrated.

Refresh agent wiring after framework upgrade:

```bash
plumbus init --patch
plumbus doctor
```

---

## Agent checklist

Work through this list when upgrading an existing Plumbus app to 0.5.x:

- [ ] **Flow steps** — every `step.capability` uses `<domain>.<name>`
- [ ] **`effects.capabilities`** — every invoke target listed with canonical names
- [ ] **Handlers** — replace direct handler imports with `ctx.capabilities.invoke`
- [ ] **Tests** — update capability name strings in fixtures, mocks, and `simulateFlow` options
- [ ] **Flow access** — step target capabilities allow caller roles (not only `system`) for user-triggered flows
- [ ] **Job flows** — remove `kind: 'job'` from flow steps; use async dispatch instead
- [ ] **MCP** — run `plumbus generate`; update tool name references if exposed via MCP
- [ ] **`plumbus generate`** — refresh `RegisteredCapabilityName`, `capability-graph.md`, MCP manifest
- [ ] **`plumbus verify`** — zero `non-canonical-capability-reference` and `direct-capability-handler-import` warnings
- [ ] **`plumbus migrate generate && apply`** — `auth_snapshot_json` on `flow_executions` (+ `job_executions`)
- [ ] **Job HTTP clients** — expect **202** + poll `GET /api/jobs/:jobId` (see `deployment.md`)
- [ ] **`plumbus init --patch`** — refresh agent wiring to pick up this playbook

---

## Further reading

| Topic | Location |
|-------|----------|
| Invoke policy and effects | `node_modules/@plumbus/core/instructions/capabilities.md` |
| Flow step auth and job blocking | `node_modules/@plumbus/core/instructions/flows.md` |
| Security model (auth snapshot) | `node_modules/@plumbus/core/instructions/security.md` |
| Production deploy + workers | `node_modules/@plumbus/core/instructions/deployment.md` |
| MCP exposure | `node_modules/@plumbus/core/instructions/mcp.md` |
