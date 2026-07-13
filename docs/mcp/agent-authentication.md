# MCP Agent Authentication (Design)

This document specifies how external AI agents authenticate to a Plumbus app over MCP. Implementation lives in `@plumbus/mcp` (`createMcpAuthAdapter`); runtime behavior reuses the existing deny-by-default access model.

## AuthContext mapping

Each configured agent token resolves to an `AuthContext`:

| Field | Value |
|-------|--------|
| `userId` | Agent's `serviceAccountId` (not a human user id) |
| `roles` | `[]` (agents use scopes + service accounts, not roles) |
| `scopes` | From config |
| `tenantId` | From config when set |
| `provider` | `'mcp'` |
| `sessionId` | `undefined` |
| `internal` | `false` |

## Access policies (unchanged)

After authentication, `evaluateAccess()` runs as for HTTP:

1. `public: true` → allow (discouraged for destructive MCP tools)
2. Caller must have a required **role** if `access.roles` is set
3. Caller must have required **scopes** if `access.scopes` is set
4. Caller `serviceAccountId` must appear in `access.serviceAccounts` when that list is set
5. If `access.tenantScoped: true`, tenant isolation applies (see below)

Deny-by-default: no matching policy → 403 at `tools/call`.

**Task requests re-authenticate.** `tasks/get`, `tasks/result`, `tasks/cancel`, and `tasks/list` independently authenticate the caller (same Bearer-token lookup) and additionally enforce task ownership: the caller's `userId` must equal `task.userId`, and tenant isolation applies normally. A leaked token grants only the task scope of the original caller.

## Tenant-scoped tools and tenanted agents

When a capability has `access.tenantScoped: true`:

- The agent's `AuthContext.tenantId` must be set and must match the tenant context used for data access.
- A cross-tenant `tools/call` (agent `tenantId` does not match the tool's tenant scope) is **denied** via existing tenant checks in the data layer and access evaluation.
- Audit records include `provider: 'mcp'` and the service account id so operators can distinguish agent denials from human JWT denials.

### `bypassTenantScope` mirrors the HTTP path

MCP follows the same per-capability rule as the HTTP route generator: when a capability declares `access.tenantScoped: false`, the runtime calls `createDependencies(authContext, { bypassTenantScope: true })` so explicitly cross-tenant capabilities can read across tenants. Tenant-scoped capabilities (the default) still enforce tenant isolation. See `packages/mcp/src/server.ts` and `packages/plumbus-core/src/api/route-generator.ts` — the two paths share this logic verbatim.

## Token carriage

| Transport | Token source |
|-----------|----------------|
| HTTP (Streamable MCP) | `Authorization: Bearer <token>` |
| stdio | `PLUMBUS_MCP_TOKEN` environment variable |

Both paths use the same lookup table: `PlumbusConfig.mcp.agents`.

## Configuration

Extend `plumbus.config.ts` / `plumbus.config.json`:

```typescript
mcp: {
  agents: {
    "agent-token-key-or-secret": {
      serviceAccountId: "billing-agent",
      scopes: ["billing:read"],
      tenantId: "tenant-uuid", // optional
    },
  },
},
```

Loaded via `loadConfig()` like database and auth settings. v1 is a **static map**; no runtime agent registration API.

`plumbus mcp serve` builds `createMcpAuthAdapter({ agents: config.mcp?.agents ?? {}, envToken: process.env.PLUMBUS_MCP_TOKEN })` when `mcp.agents` is non-empty.

## Token resolution

Both transports use the same lookup against `mcp.agents`. The implementation is `resolveMcpAgentToken` in [packages/mcp/src/auth/resolve-agent-token.ts](../../packages/mcp/src/auth/resolve-agent-token.ts).

Resolution order:

1. **`Authorization: Bearer <value>` header**, when present (HTTP transport always; stdio when the runner forwards request metadata). If `<value>` is a key in `mcp.agents`, that entry is used.
2. **`envToken`** (passed by `plumbus mcp serve` from `PLUMBUS_MCP_TOKEN`). If the env value is a key in `mcp.agents`, that entry is used.
3. Otherwise `resolveMcpAgentToken` returns `null` and `createMcpAuthAdapter.authenticate` returns `null`.

There is no "secret match" or "opaque secret" branch — the map key **is** the bearer token verbatim. Pick a high-entropy string as the key.

**Examples**

| `mcp.agents` keys | Bearer / `PLUMBUS_MCP_TOKEN` | Result |
|-------------------|------------------------------|--------|
| `{ "dev-agent": { ... } }` | `dev-agent` | Resolves to that agent |
| `{ "sk-live-abc": { ... } }` | `sk-live-abc` | Resolves to that agent |
| `{ "dev-agent": { ... } }` | `wrong` | `null` auth |

### What happens when auth resolves to `null`

Behavior depends on which adapter is in effect and which transport is serving the call:

| Scenario | Adapter resolved by `plumbus mcp serve` | Null-auth behavior |
|---|---|---|
| `config.mcp.agents` has at least one entry | `createMcpAuthAdapter({ agents, envToken })` | `null` → HTTP transport returns 401 at the tool call; stdio transport surfaces a tool error. Access evaluation never runs. |
| `config.mcp.agents` is empty or unset | Falls back to the **JWT adapter** and `plumbus mcp serve` prints an "anonymous-only" warning at startup. | `null` → the MCP server substitutes an anonymous `AuthContext` (`provider: 'anonymous'`, empty roles/scopes). Only `access.public: true` tools execute. |

**Deploy with `mcp.agents` configured for any production-shaped surface.** The anonymous JWT fallback is for local dev only. `plumbus doctor` **fails** on any capability with both `exposeAs: ['mcp']` and `access.public: true` — including read-only tools.

## Audit

Capability audit entries for MCP invocations should record:

- `provider: 'mcp'`
- Service account id as actor (via `userId` / auth context)
- Standard capability name, domain, and outcome

## Threat model

- Treat agent tokens like API keys: rotate, scope minimally, never commit to git.
- Avoid `access.public: true` on any capability with `exposeAs: ['mcp']` — `plumbus doctor` fails on the combination.
- Leaked token grants only the configured scopes and service account visibility.

## Per-request ExecutionContext

Each MCP `tools/call` must:

1. `auth = await authAdapter.authenticate(token)`
2. `deps = createDependencies(auth)` — **once per call** (fresh data/audit/events bindings)
3. `ctx = createExecutionContext(deps)`; set `ctx.signal` from the MCP SDK request `extra.signal` when present
4. `executeCapability(capability, ctx, arguments)`

Do not reuse one `ExecutionContext` across concurrent tool calls. The shared `db` pool comes from server bootstrap; per-call isolation matches [route-generator.ts](../../packages/plumbus-core/src/api/route-generator.ts).

## Out of scope (v1)

- OAuth MCP authorization server
- Per-tenant agent registration UI
- Agent-specific rate limits
- Scope-filtered `tools/list` (listing is full manifest; access enforced at `tools/call`)
