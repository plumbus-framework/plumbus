# Security Model

Plumbus enforces **deny-by-default security** at every layer. No capability executes without an explicit access policy, and the framework validates authorization before handler code runs.

## Security Architecture

```
Incoming Request
       │
       ▼
┌──────────────────┐
│ Auth Adapter     │ ← JWT / Clerk / Auth0 / Custom
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

1. If `public: true` → **allow** without authentication
2. If `serviceAccounts` defined and caller is service account → check match
3. Check `roles` — caller must have **at least one** listed role
4. Check `scopes` — caller must have **all** listed scopes
5. If `tenantScoped: true` → verify `ctx.auth.tenantId` matches resource tenant
6. If no policy is defined → **deny** (deny-by-default)

## Auth Adapters

### JWT Adapter

```typescript
import { createJwtAdapter } from "plumbus-core";

const adapter = createJwtAdapter({
  issuer: "https://auth.example.com",
  audience: "my-api",
  jwksUri: "https://auth.example.com/.well-known/jwks.json",
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
│ govRuleCrossTenantDataAccess detects leaks     │
└────────────────────────────────────────────────┘
```

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
| `sensitive` | Must be encrypted, governance enforces |
| `highly_sensitive` | Encrypted + masked + restricted access |

### Encryption at Rest

Fields marked `encrypted: true` are encrypted before database storage and decrypted on read.

### Log Masking

Fields marked `maskedInLogs: true` are automatically redacted in structured log output:

```
// Log output
{ userId: "u-123", email: "***MASKED***", action: "login" }
```

## Governance Security Rules

The framework includes built-in security governance rules:

| Rule | Category | What It Checks |
|------|----------|---------------|
| `capability-missing-access-policy` | security | Capability has no access policy |
| `entity-tenant-isolation` | security | Tenant-scoped entity missing isolation |
| `sensitive-field-unencrypted` | security | Sensitive field without encryption |
| `overly-permissive-roles` | security | More than 5 roles on a capability |
| `cross-tenant-data-access` | security | Capability reads cross-tenant without isolation |
| `missing-field-classification` | privacy | User data fields without classification |
| `personal-data-in-logs` | privacy | PII fields not masked in logs |
| `excessive-data-retention` | privacy | Entities without retention policy |

## Security in AI Operations

AI requests are subject to additional security:

```
ctx.ai.generate()
       │
       ▼
┌──────────────────┐
│ PII Detection    │ ← Scan input for personal data
└──────┬───────────┘
       │
┌──────▼───────────┐
│ Classification   │ ← Block highly_sensitive data
│ Check            │
└──────┬───────────┘
       │
┌──────▼───────────┐
│ Scope Check      │ ← Caller has ai:generate scope?
└──────┬───────────┘
       │
       ▼
  Provider call
```

## Testing Security

```typescript
import {
  assertAccessAllowed,
  assertAccessDenied,
  assertCapabilityDenied,
  assertTenantIsolation,
  adminAuth,
  unauthenticated,
  serviceAccountAuth,
} from "plumbus-core/testing";

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

