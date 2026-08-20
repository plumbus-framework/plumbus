# Security Model

Plumbus enforces **deny-by-default security** at every layer. No capability executes without an explicit access policy, and the framework validates authorization before handler code runs.

## Security Architecture

```
Incoming Request
       │
       ▼
┌──────────────────┐
│ Auth Adapter     │ ← JWT / OIDC / SAML / Custom
│                  │
│ Extract:         │
│ • userId         │
│ • roles          │
│ • scopes         │
│ • tenantId       │
└────────┬─────────┘
         │
┌────────▼─────────┐
│ Access Evaluator │ ← evaluateAccess()
│                  │
│ Check:           │
│ • public?        │
│ • roles match?   │
│ • scopes match?  │
│ • tenant match?  │
│ • svc account?   │
└────────┬─────────┘
         │
    ┌────┼─────┐
    │          │
  Allow      Deny → 403
    │
    ▼
  Handler
```

## Access Policies

Every capability declares an access policy:

```typescript
access: {
  // At least one role required
  roles: ["admin", "billing_manager"],

  // Required OAuth scopes
  scopes: ["billing:read", "billing:write"],

  // Public access (no authentication needed)
  public: true,

  // Restrict to caller's tenant
  tenantScoped: true,

  // Service account access (headless callers)
  serviceAccounts: ["event-worker", "cron-scheduler"],
}
```

### Evaluation Rules

1. If no `access` policy → **deny** (deny-by-default)
2. If `public: true` → **allow** without authentication
3. Caller must be authenticated (`userId` present)
4. If `serviceAccounts` is set and `auth.userId` matches an entry → **allow** (short-circuit; roles, scopes, and tenant checks are skipped)
5. If `tenantScoped: true` → caller must have `tenantId` in `ctx.auth`
6. Check `roles` — caller must have **at least one** listed role (when `roles` is set)
7. Check `scopes` — caller must have **all** listed scopes (when `scopes` is set)

### Flow step auth (auth snapshot)

Flow capability steps run under the **caller's stored auth snapshot**, not the worker's `system` identity. When a flow starts, the framework persists the full `AuthContext` in `flow_executions.auth_snapshot_json` and restores it on each step (with `actor` / `tenant_id` from the execution row).

- **User-triggered flows** (HTTP, API, `ctx.flows.start` from a capability) keep the original caller's `roles`, `scopes`, and `tenantId`. Capabilities invoked by flow steps must allow that identity — the engine does **not** auto-inject `system` on user flows.
- **Scheduled and worker-owned flows** still run under explicit `system` auth from the scheduler or worker bootstrap.

The deprecated `auth.internal` flag is mapped to `system` for compatibility but is no longer a blanket bypass. List `system` in `access.roles` only for capabilities that should run under scheduler/worker automation — not as a shortcut for user-triggered orchestration.

See [Flows → Capability Step](../core-concepts/flows.md#capability-step) and [Upgrading capability names](../upgrading-capability-names.md).

## MCP agent authentication

External AI agents use MCP (`plumbus mcp serve`) with the same deny-by-default access model as HTTP. Agents authenticate via opaque tokens configured in `plumbus.config.ts` → `mcp.agents`, resolved by `createMcpAuthAdapter` in `@plumbus/mcp`.

| Transport | Token |
|-----------|--------|
| HTTP | `Authorization: Bearer <token>` |
| stdio | `PLUMBUS_MCP_TOKEN` |

Resolved identity uses `provider: 'mcp'` and `userId` set to the configured `serviceAccountId`. Access then follows `serviceAccounts`, `scopes`, `roles`, and `tenantScoped` on each capability — same `evaluateAccess()` as HTTP.

MCP follows the same per-capability `bypassTenantScope` rule as the HTTP route generator: when `access.tenantScoped: false`, the runtime calls `createDependencies(auth, { bypassTenantScope: true })`. Tenant-scoped capabilities (the default) still enforce tenant isolation. Scope-filtered `tools/list` is not implemented; all MCP-exposed tools appear in the list, with enforcement at `tools/call`.

See [MCP agent authentication](../mcp/agent-authentication.md).

## Auth Adapters

### JWT Adapter

The JWT adapter verifies HMAC-SHA256 signatures using timing-safe comparison before trusting any token payload. Tokens with invalid, forged, or missing signatures are rejected.

```typescript
import { createJwtAdapter } from "@plumbus/core";

// HS256 only — for RS256/ES256 via JWKS, use createOidcAdapter instead.
const adapter = createJwtAdapter({
  secret: "your-hmac-secret",
  issuer: "https://auth.example.com",
  audience: "my-api",
  claimMapping: {
    userId: "sub",
    roles: "https://my-app.com/roles",
    scopes: "scope",
    tenantId: "https://my-app.com/tenant",
  },
});
```

### Custom Claim Mapping

```typescript
interface JwtClaimMapping {
  userId?: string;     // JWT claim → AuthContext.userId
  roles?: string;      // JWT claim → AuthContext.roles
  scopes?: string;     // JWT claim → AuthContext.scopes
  tenantId?: string;   // JWT claim → AuthContext.tenantId
}
```

### Password Utilities

For first-party email/password authentication, use the framework helpers instead of app-local crypto code:

```typescript
import { hashPassword, verifyPassword } from "@plumbus/core";

const passwordHash = await hashPassword(input.password);
const valid = await verifyPassword(input.password, user.passwordHash);
```

`hashPassword()` uses Node.js `scrypt` and stores credentials as `salt:hash`. `verifyPassword()` uses a timing-safe comparison and returns `false` for malformed stored hashes.

### OIDC Adapter

The OIDC adapter validates JWT tokens issued by OpenID Connect providers. It fetches the provider's JWKS public keys and verifies RS256/ES256 signatures.

```typescript
import { createOidcAdapter } from "@plumbus/core";

const adapter = createOidcAdapter({
  issuer: "https://auth.example.com",
  audience: "my-client-id", // expected client ID / API audience
  // jwksUri: "...",       // optional — defaults from OIDC discovery
  // jwksCacheTtl: 3600,   // optional
});
```

The adapter:
- Fetches the OIDC discovery document from `{issuer}/.well-known/openid-configuration`
- Retrieves JWKS public keys from the provider's `jwks_uri`
- Verifies RS256/ES256 token signatures using the matching `kid`
- Validates `iss`, `aud`, and `exp` claims
- Maps standard OIDC claims (`sub`, `email`, `roles`) to `AuthContext`

Use this adapter for **stateless bearer** traffic (API clients, MCP, optional `createAuthRuntime({ bearer })` coexistence). It does **not** implement browser login redirects or session cookies.

### `@plumbus/auth` session runtime (optional)

For **browser login** with opaque server sessions, install `@plumbus/auth` and pass `createAuthRuntime()` to `createServer({ authenticationRuntime })` (core **0.6.8+**).

| Concern | Behavior |
|---|---|
| Login | Redirect to IdP (`/auth/login`), callback with code + PKCE |
| Session | HttpOnly `__Host-plumbus_session` cookie — not a JWT |
| CSRF | `GET /auth/session` returns `csrfToken`; mutating requests require `X-CSRF-Token` |
| Authorization | App-owned `resolveAuthorization` → `ctx.auth.roles/scopes/tenantId` on every request |
| Bearer coexistence | Optional bearer adapter checked **before** session cookie |

With `authenticationRuntime` supplied, **`auth.secret` is not required** in Plumbus config for browser deployments.

See [docs/auth/README.md](../auth/README.md) for wiring, Cognito, and migration from JWT/localStorage scaffolding.

### SAML Adapter

The SAML adapter validates SAML 2.0 assertions from enterprise identity providers. It verifies XML signatures using the IdP's X.509 certificate.

```typescript
import { createSamlAdapter } from "@plumbus/core";

const adapter = createSamlAdapter({
  idpCertificate: certPem,
  issuer: "https://idp.example.com",   // expected SAML issuer (IdP entity ID)
  audience: "https://app.example.com", // expected audience (SP entity ID / ACS URL)
});
```

The adapter:
- Decodes and parses base64-encoded SAML responses
- Verifies `RSA-SHA256` XML signatures against the IdP certificate
- Validates `Issuer`, `Audience`, and `NotOnOrAfter` conditions
- Extracts `NameID`, email, roles, and display name from assertions
- Maps SAML attributes to `AuthContext`

### SCIM 2.0 Provisioning

The SCIM service handles user lifecycle management from identity providers. Apps implement a `ScimUserRepository` and wire it to the framework service.

```typescript
import { createScimService } from "@plumbus/core";

const scim = createScimService(
  { bearerToken: "idp-token", baseUrl: "https://app.example.com/scim/v2" },
  userRepository,
);

// Exposes: createUser, getUser, replaceUser, patchUser, deleteUser, listUsers
```

SCIM endpoints authenticate using a bearer token provided by the IdP. The service handles:
- `POST /Users` — create provisioned user
- `GET /Users/:id` — retrieve user
- `PUT /Users/:id` — full user replacement
- `PATCH /Users/:id` — partial updates (supports `replace` operations)
- `DELETE /Users/:id` — deactivate user
- `GET /Users` — paginated user listing

## Tenant Isolation

Multi-tenancy is enforced at multiple layers:

```
┌────────────────────────────────────────────────┐
│ Layer 1: Access Policy                         │
│ tenantScoped: true → verify caller tenant      │
├────────────────────────────────────────────────┤
│ Layer 2: Data Repository                       │
│ Auto-filter WHERE tenant_id = ctx.auth.tenantId│
├────────────────────────────────────────────────┤
│ Layer 3: Event Routing                         │
│ Events scoped to originating tenant            │
├────────────────────────────────────────────────┤
│ Layer 4: Governance Rules                      │
│ ruleCrossTenantDataAccess detects leaks        │
└────────────────────────────────────────────────┘
```

### Database-Per-Tenant Data Planes

Row-level scoping (Layer 2) keeps one database honest. Deployments that need a **database per tenant** get a fifth layer: the tenant's work runs against its own database, opened as a least-privilege role, so a routing mistake fails to connect rather than reading another tenant's rows.

Three framework mechanisms cover it, and an application supplies only its own routing table:

| Step | Mechanism |
|------|-----------|
| Create the tenant's database, owner role and runtime role | `provisionDataPlane()` (idempotent; identifiers validated and quoted) |
| Look up where a tenant lives, and cache the open handles | `createPooledDataPlaneResolver({ describe, connect })` |
| Open one database as one role | `openDataPlaneConnection({ target })` |

```typescript
import {
  createPooledDataPlaneResolver,
  openDataPlaneConnection,
} from "@plumbus/core";

const resolver = createPooledDataPlaneResolver<Placement>({
  // The application owns routing: where does this tenant live?
  describe: async (tenantRef) => placements.get(tenantRef),
  // The framework owns the connection.
  connect: ({ descriptor }) =>
    openDataPlaneConnection({
      target: {
        host: descriptor.connectionInfo.host,
        port: descriptor.connectionInfo.port,
        database: descriptor.connectionInfo.database,
        user: descriptor.connectionInfo.runtimeRole,
        password: descriptor.connectionInfo.runtimePassword,
      },
      maxConnections: 4,
      applicationName: "my-app",
    }),
});

const { db, coreSchema } = await resolver.resolve(tenantRef);
```

`describe` returning `undefined` throws `UnknownTenantError` — the resolver never falls back to another database.

`openDataPlaneConnection` returns the `{ db, close }` pair the resolver requires, and is deliberately narrow about three things:

- **Bounded.** `maxConnections` defaults to `DEFAULT_DATA_PLANE_POOL_SIZE` (5) and may not exceed `MAX_DATA_PLANE_POOL_SIZE` (64). Since a resolver keeps many data planes open at once, the per-tenant ceiling is what keeps the total number of server backends finite.
- **Quiet.** Passwords and connection strings never reach a message, an error's metadata, or the driver's notice stream. Failures raise `DataPlaneConnectionError` carrying `host`, `port`, `database`, `user` and `sqlState` only, with the driver's own text scrubbed of any credential it echoed back.
- **Per-tenant.** Every call builds its own pool with no shared state, and the returned `close` is idempotent — the resolver calls it on eviction, invalidation and `close()`.

The connection is verified with one round trip before it is returned (`verify: false` opts out), so a wrong credential or an unreachable placement fails at resolve time instead of inside the first capability that queries. A target may also be given as `{ connectionString }` for hosts whose placement records carry a URL; the string is treated as a secret throughout.

### Cross-Tenant Admin Access (bypassTenantScope)

Capabilities with `access.tenantScoped: false` automatically bypass data-layer tenant filtering. This allows admin/back-office capabilities to query across all tenants without being restricted to the caller's `tenantId`.

The bypass propagates through the route generator → data service → repositories:
- `createRepository()` accepts `bypassTenantScope?: boolean` — when true, `tenantFilter()` returns `undefined` and `create()` does not auto-inject `tenantId`
- `EntityRegistry.createDataService()` accepts `bypassTenantScope?: boolean` and forwards it to all repositories
- The route generator detects `capability.access.tenantScoped === false` and passes `{ bypassTenantScope: true }` to `createDependencies()`

This is intentional for admin dashboards that need to view/manage data across all tenants while still requiring role-based authorization.

Worker/flow data services no longer bypass tenant scoping automatically when `tenantId` is missing. Flow executions must carry a `tenantId`, or capabilities must declare `access.tenantScoped: false` for explicit cross-tenant admin routes.

## Field-Level Security

### Data Classification

```typescript
fields: {
  name: field.string({ classification: "personal" }),
  ssn: field.string({ classification: "highly_sensitive", encrypted: true }),
  email: field.string({ classification: "personal", maskedInLogs: true }),
}
```

| Classification | Controls Applied |
|---------------|------------------|
| `public` | No restrictions |
| `internal` | Not exposed in public APIs |
| `personal` | PII — masked in logs, governance warns on exposure |
| `sensitive` | Governance recommends `encrypted: true` for at-rest protection; masked in logs when classified |
| `highly_sensitive` | Same as `sensitive`, plus stricter governance — set `encrypted: true` and `maskedInLogs: true` for production |

### Encryption at Rest

Fields marked `encrypted: true` are encrypted before database storage (AES-256-GCM when `PLUMBUS_ENCRYPTION_KEY` is set) and decrypted on read. Legacy plaintext values without the `plumbus:enc:v1:` prefix are returned as-is.

### Log Masking

Fields marked `maskedInLogs: true` (or classified `personal` / `sensitive` / `highly_sensitive`) are automatically redacted in audit logs and structured capability log metadata:

```
// Log output
{ userId: "u-123", email: "***", action: "login" }
```

## Governance Security Rules

The framework includes built-in security governance rules:

| Rule ID | Category | What It Checks |
|---------|----------|---------------|
| `security.capability-access-policy` | security | Capability has no access policy |
| `security.no-tenant-isolation` | security | Tenant-scoped entity missing isolation |
| `security.overly-permissive-roles` | security | Wildcard role `'*'` on a capability |
| `security.cross-tenant-data-access` | security | Capability reads cross-tenant without isolation |
| `privacy.sensitive-field-unencrypted` | privacy | Sensitive field without `encrypted: true` |
| `privacy.missing-field-classification` | privacy | User data fields without classification |
| `privacy.personal-data-in-logs` | privacy | PII fields not marked `maskedInLogs` |
| `privacy.excessive-data-retention` | privacy | Entities without retention policy |

## Audit Integration

Authentication events produce audit records for security monitoring and compliance. The capability executor automatically records audit when `audit` is configured:

```typescript
export const ssoCallback = defineCapability({
  // ...
  audit: {
    enabled: true,
    event: "auth.sso_callback",
  },
  handler: async (ctx, input) => {
    // Explicit failure records with specific reasons
    if (user.active === false) {
      await ctx.audit.record("auth.login_failed", {
        email: input.email,
        externalId: input.externalId,
        reason: "account_inactive",
      });
      throw new Error("User account is inactive");
    }
    // ...
  },
});
```

Audit records include: actor identifier, authentication provider, timestamp, capability name, domain, outcome (success/failure/denied), and any additional metadata.

For testing, use `mockAudit()` to capture and verify audit records:

```typescript
import { mockAudit } from "@plumbus/core/testing";

const audit = mockAudit();
const ctx = createTestContext({ audit });
// ... run capability ...
const failRecord = audit.records.find(r => r.eventType === "auth.login_failed");
expect(failRecord?.metadata?.reason).toBe("invalid_credentials");
```

## Security in AI Operations

AI requests are subject to additional security when `aiProviders.security` is configured (env or config file). Without that block, classified-field scanning is not active — opt in explicitly.

```
ctx.ai.generate() / generateWithUsage() / streamGenerate()
       │
       ▼
┌──────────────────┐
│ Field scan       │ ← Match input keys to entity field classifications
└──────┬───────────┘
       │
┌──────▼───────────┐
│ mode: redact     │ ← Replace at/above redactThreshold → continue
│ mode: block      │ ← Throw when at/above warnThreshold
└──────┬───────────┘
       │
       ▼
  Provider call
```

See [AI Integration → Security Controls](../ai/ai-integration.md#security-controls) for `AISecurityConfig`, thresholds, and env vars.

## Testing Security

```typescript
import {
  assertCapabilityAllowed,
  assertCapabilityDenied,
  assertTenantIsolation,
  adminAuth,
  unauthenticated,
  serviceAccountAuth,
} from "@plumbus/core/testing";

// Test access denied for unauthenticated
await assertCapabilityDenied(createOrder, orderInput, {
  auth: unauthenticated(),
});

// Test access allowed for admin
await assertCapabilityAllowed(createOrder, orderInput, {
  auth: adminAuth("tenant-1"),
});

// Test tenant isolation
await assertTenantIsolation(getOrders, {}, "tenant-1", {
  data: { Order: [
    { id: "1", tenantId: "tenant-1" },
    { id: "2", tenantId: "tenant-2" },
  ]},
});
```

