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

1. If no `access` policy → **deny**
2. If `public: true` → allow
3. Authenticate identity → populate `ctx.auth` (`userId` required for non-public)
4. If `serviceAccounts` is set and `auth.userId` matches → **allow** (short-circuit; skips roles, scopes, and tenant checks)
5. If `tenantScoped: true` on the capability → caller must have `tenantId` in `ctx.auth`
6. Check `roles` — user must have at least one matching role (when `roles` is set)
7. Check `scopes` — user must have all required scopes (when `scopes` is set)

If any check fails → **403 Forbidden** with audit record.

## Flow auth snapshot (0.5+)

Flow capability steps run under the **caller's stored auth snapshot**, not the worker's `system` identity. When a flow starts, the framework persists the full `AuthContext` in `flow_executions.auth_snapshot_json` and restores it on each step (with `actor` / `tenant_id` from the execution row).

- **User-triggered flows** (HTTP, API, manual `ctx.flows.start`) — steps enforce the original caller's roles and scopes. Capabilities must list those roles in `access.roles` (or `public: true`). There is no implicit `system` elevation on every step.
- **Scheduled / worker-owned flows** — still run under explicit `system` auth from the scheduler or worker bootstrap.

If flow steps return **403** after upgrading to 0.5.x, audit `access.roles` on step target capabilities. See `upgrading-0.5-capabilities.md` for the migration checklist.

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

**Entity-level filtering:** when an entity declares `tenantScoped: true`, repository queries automatically inject `WHERE tenantId = ctx.auth.tenantId`. Cross-tenant data access is blocked at the framework level.

**Capability-level gate:** the capability's `access.tenantScoped` flag requires the caller to carry a `tenantId` in `ctx.auth`. It does not turn on repository filtering by itself — that follows the entity definition.

**Cross-tenant admin bypass:** capabilities with `access.tenantScoped: false` pass `bypassTenantScope: true` into `createDependencies()`, allowing explicitly cross-tenant admin routes while role/scope checks still apply.

Events carry `tenantId` and are only delivered to matching consumers.

## Field Classification & Edit Zones

Entity fields with `classification: "sensitive"` or `"highly_sensitive"`:
- Are masked in logs and audit records
- Trigger governance warnings if used in AI prompts
- Can be flagged for encryption at rest (`encrypted: true` + `PLUMBUS_ENCRYPTION_KEY`)

When encryption is enabled, repositories reject `findMany`/`aggregate` filters and aggregate functions on encrypted string columns (ciphertext is not queryable at the SQL layer). See [entities.md](./entities.md#aggregates-sum--group-by--distinct).

**AI prompt scanning** is separate and **opt-in**: configure `aiProviders.security` (or `AI_SECURITY_*` env) to warn/redact/block classified fields in `ctx.ai.*` inputs. Without that config, classification alone does not scan prompts. See `ai.md` § Security.

### Edit Zones

| Zone | Description |
|------|-------------|
| **Safe** | Application code in `app/` — capabilities, flows, entities, events, prompts |
| **Restricted** | Configuration files in `config/` — changes may affect security posture |
| **Forbidden** | Framework internals, generated code in `.plumbus/generated/` |

## Authentication Adapters

Plumbus uses pluggable auth adapters. The adapter normalizes tokens into `AuthContext`:

- **JWT (default)** — `createJwtAdapter()` verifies HMAC-SHA256 tokens (`secret`, optional `issuer`/`audience`, `claimMapping`)
- **OIDC** — `createOidcAdapter()` verifies RS256/ES256 via JWKS (`issuer`, `audience`, optional `jwksUri`/`jwksCacheTtl`)
- **SAML 2.0** — `createSamlAdapter()` validates SAML assertions (`idpCertificate`, `issuer`, `audience`)
- **SCIM 2.0 provisioning** — `createScimService()` for IdP-driven user lifecycle (`createUser`, `patchUser`, etc.)
- **JWT signing** — `signJwt()` for first-party token issuance
- **Custom** — implement the `AuthAdapter` interface

See `docs/security/security-model.md` for full adapter examples.

## Password Utilities

When building first-party email/password authentication, use the framework helpers instead of app-local crypto:

```ts
import { hashPassword, verifyPassword } from "@plumbus/core";
```

- `hashPassword(password)` stores credentials as `salt:hash` using Node.js `scrypt`
- `verifyPassword(password, storedHash)` performs a timing-safe comparison
- Store only the returned hash string in entity fields marked `classification: "highly_sensitive"`
