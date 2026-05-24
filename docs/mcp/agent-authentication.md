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

## Tenant-scoped tools and tenanted agents

When a capability has `access.tenantScoped: true`:

- The agent's `AuthContext.tenantId` must be set and must match the tenant context used for data access.
- A cross-tenant `tools/call` (agent `tenantId` does not match the tool's tenant scope) is **denied** via existing tenant checks in the data layer and access evaluation.
- Audit records include `provider: 'mcp'` and the service account id so operators can distinguish agent denials from human JWT denials.

MCP v1 does **not** use `bypassTenantScope` (that HTTP option is for internal/admin routes only).

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

`plumbus mcp serve` builds `createMcpAuthAdapter(loadConfig().mcp?.agents ?? {})`.

## PLUMBUS_MCP_TOKEN precedence (stdio)

Resolution order when authenticating on stdio:

1. If `Authorization: Bearer <value>` is present on the MCP session (some stdio clients support metadata), use `<value>` as the lookup key (same as HTTP).
2. Else if `PLUMBUS_MCP_TOKEN` is set:
   - If the value matches a **key** in `mcp.agents`, use that entry.
   - Else if the value matches a **key** used as the token secret (the map key string equals the env value), use that entry.
   - Else: treat the env value as an opaque secret and find the agent entry whose map key equals that secret (single match required).
3. If no match: `authenticate` returns `null` → `tools/call` is denied.

**Examples**

| `mcp.agents` keys | `PLUMBUS_MCP_TOKEN` | Result |
|-------------------|----------------------|--------|
| `{ "dev-agent": { ... } }` | `dev-agent` | Resolves via key name |
| `{ "sk-live-abc": { ... } }` | `sk-live-abc` | Resolves via secret key |
| `{ "dev-agent": { ... } }` | `wrong` | `null` auth → denial |

Unknown or missing token → denial (never fall back to anonymous for MCP tools).

## Audit

Capability audit entries for MCP invocations should record:

- `provider: 'mcp'`
- Service account id as actor (via `userId` / auth context)
- Standard capability name, domain, and outcome

## Threat model

- Treat agent tokens like API keys: rotate, scope minimally, never commit to git.
- Avoid `public: true` on capabilities with `exposeAs: ['mcp']` and `mcp.dangerous: true`.
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
