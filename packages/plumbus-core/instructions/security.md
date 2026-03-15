# Security Model

Plumbus uses a **deny-by-default** security model. Every capability must declare its access policy explicitly.

## Access Policies

```ts
access: {
  roles: ["admin", "billing"],     // Required roles (any match)
  scopes: ["refunds:write"],       // Required scopes (all must match)
  public: false,                    // If true, no auth required
  tenantScoped: true,              // Enforce tenant isolation
  serviceAccounts: ["payment-svc"], // Allow service-to-service auth
}
```

### Evaluation Order
1. If `public: true` → allow
2. Authenticate identity → populate `ctx.auth`
3. Check `roles` — user must have at least one matching role
4. Check `scopes` — user must have all required scopes
5. If `tenantScoped: true` — verify `ctx.auth.tenantId` matches target data
6. Check `serviceAccounts` — for service-to-service calls

If any check fails → **403 Forbidden** with audit record.

## Auth Context (`ctx.auth`)

| Property | Type | Description |
|----------|------|-------------|
| `userId` | string? | Authenticated user ID |
| `roles` | string[] | User's assigned roles |
| `scopes` | string[] | User's permission scopes |
| `tenantId` | string? | Tenant the user belongs to |
| `provider` | string | Auth provider (e.g., "oidc", "auth0") |
| `sessionId` | string? | Session identifier |
| `authenticatedAt` | Date? | When authentication occurred |

## Tenant Isolation

When `tenantScoped: true`:
- All repository queries automatically inject `WHERE tenantId = ctx.auth.tenantId`
- Cross-tenant data access is blocked at the framework level
- Events carry `tenantId` and are only delivered to matching consumers

## Field Classification & Edit Zones

Entity fields with `classification: "sensitive"` or `"highly_sensitive"`:
- Are masked in logs and audit records
- Trigger governance warnings if used in AI prompts
- Can be flagged for encryption at rest

### Edit Zones

| Zone | Description |
|------|-------------|
| **Safe** | Application code in `app/` — capabilities, flows, entities, events, prompts |
| **Restricted** | Configuration files in `config/` — changes may affect security posture |
| **Forbidden** | Framework internals, generated code in `.plumbus/generated/` |

## Authentication Adapters

Plumbus uses pluggable auth adapters. The default is JWT validation. The adapter normalizes tokens into `AuthContext`:

- JWT (default) — validates JWT tokens, extracts claims
- Auth0, Clerk, Cognito — provider-specific adapters (community)
- Custom — implement the adapter interface

## Password Utilities

When building first-party email/password authentication, use the framework helpers instead of app-local crypto:

```ts
import { hashPassword, verifyPassword } from "plumbus-core";
```

- `hashPassword(password)` stores credentials as `salt:hash` using Node.js `scrypt`
- `verifyPassword(password, storedHash)` performs a timing-safe comparison
- Store only the returned hash string in entity fields marked `classification: "highly_sensitive"`
