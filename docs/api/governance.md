# API Governance

Plumbus governance is **advisory** — warnings and info messages that surface incomplete or risky API metadata. Governance never hard-blocks deploys. Hard contract failures (manifest errors, policy violations, path-param mismatches, fixture issues) are validated separately by `plumbus api validate`.

API governance rules live in `@plumbus/core` (`apiRules` in `src/governance/rules/api.ts`) and run during `plumbus verify` alongside other framework governance checks.

**Previous:** [compatibility.md](./compatibility.md) · **Next:** [overview.md](./overview.md) (doc map)

---

## When governance helps

Run `plumbus verify` when:

- You want a holistic health check across capabilities, entities, flows, and API exposure.
- CI should nudge developers toward complete auth metadata before partners integrate.
- You are auditing API-exposed capabilities for missing `operationId` or idempotency declarations.

Use `plumbus api validate` when you need **hard gates** on manifest, policy, path params, and fixtures. Pass `--fail-on-governance` when CI should also fail on advisory `apiRules` signals (same rules as `plumbus verify`). The two commands complement each other.

---

## `plumbus verify` vs `plumbus api validate`

| Concern | `plumbus verify` | `plumbus api validate` |
|---|---|---|
| Advisory API metadata rules | Yes (`apiRules`) | Yes (same rules included) |
| Manifest schema and registry | No | Yes |
| Structure policy (`policy.*`) | No | Yes |
| Path parameter mapping | No | Yes |
| Test fixture schema + containment | No | Yes |
| Blocks CI on findings | No (warnings only) | Yes (`exit 1` on hard findings); add `--fail-on-governance` to also fail on advisory API rules |

Manifest, policy, path-param, and fixture findings exist **only** in `plumbus api validate` — not in general verify alone.

---

## Advisory rules

### `api.metadata-without-exposure`

| | |
|---|---|
| **Severity** | Warning |
| **Trigger** | Capability has an `api` block but `exposeAs` does not include `'api'` |
| **Remediation** | Add `exposeAs: ['api']` or remove the unused `api` block |

`defineCapability()` actually rejects `api` without `exposeAs` at definition time — this rule catches registry inconsistencies from dynamic loading or partial migrations.

### `api.public-mutation-without-idempotency`

| | |
|---|---|
| **Severity** | Warning |
| **Trigger** | API-exposed capability with `access.public: true` and a mutating HTTP method (`POST`, `PATCH`, `PUT`, `DELETE`) lacks `api.idempotency` metadata |
| **Remediation** | Add `api.idempotency: { required: true, header: 'Idempotency-Key' }` |

Public mutations without documented idempotency are risky — retries from partners can double-apply side effects.

**Example fix:**

```typescript
api: {
  operationId: 'createWebhook',
  method: 'POST',
  path: '/webhooks',
  idempotency: { required: true, header: 'Idempotency-Key', ttl: '24h' },
},
```

### `api.missing-auth`

| | |
|---|---|
| **Severity** | Warning |
| **Trigger** | API-exposed, non-public capability has no `api.auth.scopes`, `access.scopes`, or `access.roles` |
| **Remediation** | Document auth requirements in at least one of those fields |

Partners and OpenAPI consumers need to know how to authenticate.

### `api.deprecated-without-replacement`

| | |
|---|---|
| **Severity** | Info |
| **Trigger** | `api.stability: 'deprecated'` without `api.deprecation.replacement` |
| **Remediation** | Add `deprecation.replacement` with the successor `operationId` |

```typescript
api: {
  stability: 'deprecated',
  deprecation: {
    replacement: 'getRefundV2',
    sunset: '2027-01-01',
  },
},
```

### `api.missing-operation-id`

| | |
|---|---|
| **Severity** | Warning |
| **Trigger** | API-exposed capability missing `api.operationId` |
| **Remediation** | Add `api.operationId` |

`defineCapability()` requires `operationId` when `exposeAs: ['api']` — this rule is defensive for edge cases in the inventory scan.

---

## Rules reference table

| Rule ID | Severity | Category |
|---|---|---|
| `api.metadata-without-exposure` | warning | architecture |
| `api.public-mutation-without-idempotency` | warning | architecture |
| `api.missing-auth` | warning | architecture |
| `api.deprecated-without-replacement` | info | architecture |
| `api.missing-operation-id` | warning | architecture |

All rules are registered in `apiRules` and exported from `@plumbus/core` governance.

---

## Example verify output

```
⚠ api.missing-auth
  API-exposed capability "listInvoices" has no documented auth requirements
  → Add api.auth.scopes, access.scopes, or access.roles

ℹ api.deprecated-without-replacement
  Deprecated API capability "getRefund" has no replacement operation
  → Add api.deprecation.replacement
```

Fix warnings before publishing to partners. They do not prevent `plumbus verify` from completing successfully.

---

## Relationship to structure policy

| Layer | Nature | Examples |
|---|---|---|
| Governance (`apiRules`) | Advisory | Missing auth docs, missing idempotency on public mutations |
| Structure policy | Hard validate | `policy.public-test-forbidden`, `policy.mutation-over-get` |

A capability can pass governance (warnings only) but fail `plumbus api validate` on policy grounds — and vice versa.

---

## Agent wiring

Consumer apps initialized with `plumbus init` at the current **`AGENT_WIRING_VERSION`** reference `@plumbus/api/instructions/*` and `instructions/upgrading-0.5-capabilities.md` when the package is installed. Run `plumbus init --patch` to refresh older projects.

Core agent instructions at `node_modules/@plumbus/core/instructions/api.md` point to both package instructions and these docs.

---

## Related topics

- [overview.md](./overview.md) — full doc map and request lifecycle
- [structure-policy.md](./structure-policy.md) — hard policy rules
- [exposure-model.md](./exposure-model.md) — `api` metadata fields governance checks
- [Core governance](../core-concepts/governance.md) — framework-wide governance model
