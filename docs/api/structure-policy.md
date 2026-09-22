# API Structure Policy

Structure policy validates **safety-focused** rules on the resolved API manifest. It catches tenant-boundary leaks, unsafe HTTP verb mappings, and forbidden public+test combinations before partners integrate.

Stylistic rules (casing conventions, pluralization, pagination parameter matrices) are intentionally deferred beyond MVP — the policy engine focuses on security and HTTP semantics.

Policy violations surface in `plumbus api validate` as `policy.*` findings. They are hard failures for contract validation (not advisory like governance rules).

**Previous:** [test-intent.md](./test-intent.md) · **Next:** [compatibility.md](./compatibility.md)

---

## When to configure policy

Add a `policy` block to `api.yaml` when:

- Tenant identity must come from auth context, never from request parameters.
- You want to forbid `action` capabilities mapped to `GET`.
- You want to block non-`query` capabilities from using GET with body-like input fields.

Omit `policy` for early prototypes — only `policy.public-test-forbidden` still applies (it does not require a `policy` block).

---

## Policy configuration

```yaml
apiVersion: plumbus.dev/v1
name: partner-api
basePath: /api/v1

policy:
  tenantRouting:
    mode: auth-context
    forbidExplicitTenantInput: true
    forbiddenParams:
      path: []
      query: [orgSlug]
      body: []
  methodSemantics:
    forbidMutationOverGet: true    # default true when omitted
    forbidGetBody: true            # default true when omitted

expose:
  - capability: billing.listRefunds
    operationId: listRefunds
    method: GET
    path: /refunds
```

---

## Rule: public + test forbidden

**Code:** `policy.public-test-forbidden`

Public capabilities (`access.public: true`) must not enable test intent. Allowing anonymous access plus fixture replay would let unauthenticated callers probe endpoint shapes.

### Example that triggers the rule

```typescript
defineCapability({
  name: 'healthCheck',
  kind: 'query',
  domain: 'system',
  exposeAs: ['api'],
  access: { public: true },
  api: {
    operationId: 'healthCheck',
    method: 'GET',
    path: '/health',
    test: { enabled: true, modes: ['safe-reply'] },  // ← forbidden
  },
  // ...
});
```

**Validate time:** `plumbus api validate` reports `policy.public-test-forbidden`.

**Runtime:** even if misconfigured, authenticated test intent on a public endpoint with test enabled returns `400 test_intent_not_supported`.

**Fix:** remove `test` config or remove `access.public`.

---

## Rule: mutation over GET

**Code:** `policy.mutation-over-get`

`action` and `job` capabilities must not be projected to `GET`. Mutations over GET break HTTP semantics and invite caching proxies to execute writes.

Controlled by `policy.methodSemantics.forbidMutationOverGet` (defaults to **true** when the policy block exists).

### Example that triggers the rule

```yaml
expose:
  - capability: billing.approveRefund   # kind: action
    operationId: approveRefund
    method: GET                          # ← forbidden
    path: /refunds/{refundId}/approve
```

**Fix:** use `POST`, `PATCH`, `PUT`, or `DELETE` for `action` capabilities.

Note: `job` capabilities cannot be API-exposed at all (`defineCapability` rejects them). This rule is defensive for manifest entries that might reference invalid projections.

---

## Rule: GET with body (`get-with-body`)

**Code:** `policy.get-with-body`

When `forbidGetBody` is enabled (default **true**), non-`query` capabilities exposed via `GET` with input fields beyond path parameters are flagged. Those fields would need a request body, which GET should not carry.

`query` capabilities may use GET with query parameters normally — non-path input fields become query params, not body.

### Example that triggers the rule

```typescript
// kind: 'action' — not a query
defineCapability({
  name: 'searchRefunds',
  kind: 'action',
  api: { method: 'GET', path: '/refunds/search', /* ... */ },
  input: z.object({
    query: z.string(),
    status: z.enum(['pending', 'approved']),
  }),
});
```

`query` and `status` are non-path fields on a non-`query` kind exposed via GET → `policy.get-with-body`.

**Fix:** change `kind` to `query`, or use `POST` with a request body.

---

## Rule: tenant input forbidden

**Codes:** `policy.tenant-input-forbidden` (validate), `tenant_boundary_violation` (runtime 403)

When `tenantRouting.mode` is `auth-context` and `forbidExplicitTenantInput` is **true**, tenant identity must come from the authenticated context — not from path, query, or body parameters.

### Default forbidden parameters

Always forbidden when the rule is active:

- `orgId`
- `tenantId`

Plus any additional names from `forbiddenParams.path`, `forbiddenParams.query`, and `forbiddenParams.body`.

### Validate-time example

```yaml
policy:
  tenantRouting:
    mode: auth-context
    forbidExplicitTenantInput: true

expose:
  - capability: billing.getRefund
    operationId: getRefund
    method: GET
    path: /tenants/{tenantId}/refunds/{refundId}   # ← tenantId in path
```

Capability input includes `tenantId` → `policy.tenant-input-forbidden`.

### Runtime example

Even if validation is bypassed, `collectExplicitTenantViolations()` runs on every request. A partner sending `tenantId` in query or body receives:

```json
{
  "ok": false,
  "error": {
    "code": "tenant_boundary_violation",
    "message": "Tenant boundary violation",
    "requestId": "…"
  },
  "meta": { "apiVersion": "v1" }
}
```

**Fix:** remove tenant fields from input schemas and paths; rely on `access.tenantScoped` and auth context injection.

### `path-prefix` mode

`tenantRouting.mode: path-prefix` is defined in the schema for future use. The MVP policy engine validates `auth-context` rules only. Path-prefix tenant routing is not enforced by structure policy in v1.

---

## Rule summary table

| Code | Trigger | Severity | Enforced at |
|---|---|---|---|
| `policy.public-test-forbidden` | `access.public` + `test.enabled` | Validate failure | Validate + runtime |
| `policy.mutation-over-get` | `action`/`job` kind + `GET` method | Validate failure | Validate |
| `policy.get-with-body` | non-`query` kind + `GET` + non-path input fields | Validate failure | Validate |
| `policy.tenant-input-forbidden` | forbidden param in path or input schema | Validate failure | Validate + runtime |

---

## Relationship to governance

Structure policy findings are **hard validation errors** in `plumbus api validate`. Governance rules (see [governance.md](./governance.md)) are **advisory warnings** in `plumbus verify` — they never block deploys.

---

## Related topics

- [manifest.md](./manifest.md) — `policy` block in `api.yaml`
- [test-intent.md](./test-intent.md) — public+test interaction
- [exposure-model.md](./exposure-model.md) — capability kinds and HTTP methods
- [overview.md](./overview.md) — tenant guard in request lifecycle
