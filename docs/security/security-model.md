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

1. If `public: true` → **allow** without authentication
2. If `serviceAccounts` defined and caller is service account → check match
3. Check `roles` — caller must have **at least one** listed role
4. Check `scopes` — caller must have **all** listed scopes
5. If `tenantScoped: true` → verify `ctx.auth.tenantId` matches resource tenant
6. If no policy is defined → **deny** (deny-by-default)

## Auth Adapters

### JWT Adapter

The JWT adapter verifies HMAC-SHA256 signatures using timing-safe comparison before trusting any token payload. Tokens with invalid, forged, or missing signatures are rejected.

```typescript
import { createJwtAdapter } from "plumbus-core";

const adapter = createJwtAdapter({
  secret: "your-hmac-secret",
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

### Password Utilities

For first-party email/password authentication, use the framework helpers instead of app-local crypto code:

```typescript
import { hashPassword, verifyPassword } from "plumbus-core";

const passwordHash = await hashPassword(input.password);
const valid = await verifyPassword(input.password, user.passwordHash);
```

`hashPassword()` uses Node.js `scrypt` and stores credentials as `salt:hash`. `verifyPassword()` uses a timing-safe comparison and returns `false` for malformed stored hashes.

### OIDC Adapter

The OIDC adapter validates JWT tokens issued by OpenID Connect providers. It fetches the provider's JWKS public keys and verifies RS256/ES256 signatures.

```typescript
import { createOidcAdapter } from "plumbus-core";

const adapter = createOidcAdapter({
  issuerUrl: "https://auth.example.com",
  audience: "my-api",
  clientId: "my-client",
});
```

The adapter:
- Fetches the OIDC discovery document from `{issuerUrl}/.well-known/openid-configuration`
- Retrieves JWKS public keys from the provider's `jwks_uri`
- Verifies RS256/ES256 token signatures using the matching `kid`
- Validates `iss`, `aud`, and `exp` claims
- Maps standard OIDC claims (`sub`, `email`, `roles`) to `AuthContext`

### SAML Adapter

The SAML adapter validates SAML 2.0 assertions from enterprise identity providers. It verifies XML signatures using the IdP's X.509 certificate.

```typescript
import { createSamlAdapter } from "plumbus-core";

const adapter = createSamlAdapter({
  idpEntityId: "https://idp.example.com",
  spEntityId: "https://app.example.com",
  idpCertificate: certPem,
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
import { createScimService } from "plumbus-core";

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
import { mockAudit } from "plumbus-core/testing";

const audit = mockAudit();
const ctx = createTestContext({ audit });
// ... run capability ...
const failRecord = audit.records.find(r => r.eventType === "auth.login_failed");
expect(failRecord?.metadata?.reason).toBe("invalid_credentials");
```

## Security in AI Operations

AI requests are subject to additional security:

```
ctx.ai.generate()
       │
       ▼
┌──────────────────┐
│ PII Detection    │ ← Scan input recursively for personal data
└──────┬───────────┘
       │
┌──────▼───────────┐
│ Classification   │ ← Block highly_sensitive data (recursive)
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

