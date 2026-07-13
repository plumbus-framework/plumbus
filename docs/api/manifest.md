# API Manifest (`api.yaml`)

The optional `api.yaml` (or `api.json`) manifest names a **published API product**: its `basePath`, identity metadata, structure policy, and per-capability route overrides. Capabilities remain the source of truth for schemas and handlers; the manifest controls how they appear on the partner surface.

When no manifest file exists at the default path, the CLI and runtime synthesize one from inline `api` metadata via `buildDefaultManifest()`.

**Previous:** [exposure-model.md](./exposure-model.md) · **Next:** [openapi.md](./openapi.md)

---

## When to maintain a manifest

Maintain `api.yaml` when:

- You publish a named partner API with a versioned `basePath` (e.g. `/api/v1`).
- Multiple API products share capabilities but need different route projections.
- You need structure policy (tenant routing, GET semantics) at the API product level.
- CI validates the full contract including manifest-specific overrides.

Skip the manifest when:

- A single inline-only API with default `basePath: /api/v1` is enough.
- You are prototyping and want zero config beyond `exposeAs: ['api']` on capabilities.

---

## Minimal example

```yaml
apiVersion: plumbus.dev/v1
name: partner-api
basePath: /api/v1

expose:
  - capability: billing.getRefund
    operationId: getRefund
    method: GET
    path: /refunds/{refundId}
```

This overrides nothing beyond grouping — inline `api` metadata on `billing.getRefund` still supplies `stability`, `auth`, etc. Manifest entries must repeat `operationId`, `method`, and `path` even when they match inline values.

---

## Full-featured example

```yaml
apiVersion: plumbus.dev/v1
name: partner-api
basePath: /api/v1

identity:
  audience: external-partners
  defaultAuth: oauth2

policy:
  tenantRouting:
    mode: auth-context
    forbidExplicitTenantInput: true
    forbiddenParams:
      query: [orgSlug]
  methodSemantics:
    forbidMutationOverGet: true
    forbidGetBody: true

expose:
  - capability: billing.getRefund
    operationId: getRefund
    method: GET
    path: /refunds/{refundId}
    stability: stable
    auth:
      scopes: [refunds:read]
    docs:
      summary: Retrieve a refund
      tags: [Billing, Refunds]

  - capability: billing.approveRefund
    operationId: approveRefund
    method: POST
    path: /refunds/{refundId}/approve
    stability: stable
    auth:
      scopes: [refunds:write]
    idempotency:
      required: true
      header: Idempotency-Key
      ttl: 24h
    test:
      enabled: true
      modes: [validate-only, safe-reply]
      defaultMode: safe-reply
      safeReply:
        fixture: fixtures/refunds/approve-success.json
    deprecation:
      replacement: approveRefundV2
```

---

## Top-level fields

| Field | Required | Description |
|---|---|---|
| `apiVersion` | Yes | Schema version. Use `plumbus.dev/v1`. |
| `name` | Yes | API product name — appears in OpenAPI `info.title`. |
| `basePath` | Yes | URL prefix for all operations (e.g. `/api/v1`). Becomes OpenAPI `servers[0].url`. |
| `identity` | No | Audience label and default auth scheme hint for OpenAPI. |
| `identity.audience` | No | Human-readable audience; added to OpenAPI `info.description`. |
| `identity.defaultAuth` | No | `oauth2` or bearer hint. OAuth2 security scheme is emitted when any operation has scopes. |
| `policy` | No | Structure policy (see [structure-policy](./structure-policy.md)). |
| `expose` | Yes | Array of capability projections. |

There is no top-level `version` field in the schema. API version labels for envelopes and OpenAPI `info.version` are derived from `basePath` by `apiVersionFromManifest()` — e.g. `basePath: /api/v1` yields `v1`; paths without a `/vN` segment default to `v1`.

---

## `expose` entry fields

Each entry references a capability and describes its HTTP projection.

| Field | Required | Description |
|---|---|---|
| `capability` | Yes | Registry key `<domain>.<name>` (e.g. `billing.getRefund`). |
| `operationId` | Yes | Stable operation identifier. Must be unique within the manifest. |
| `method` | Yes | `GET`, `POST`, `PATCH`, `PUT`, or `DELETE`. |
| `path` | Yes | Route-relative path with `{param}` tokens. |
| `stability` | No | Overrides inline stability. |
| `auth.scopes` | No | Overrides inline OAuth scopes. |
| `idempotency` | No | `{ required: boolean, header: string, ttl?: string }`. |
| `test` | No | Test-intent config (see [test-intent](./test-intent.md)). |
| `docs` | No | `summary`, `description`, `tags` for generated docs. |
| `deprecation` | No | `sunset`, `replacement` for deprecated operations. |

---

## Precedence rules

Resolution order when serving, validating, or generating OpenAPI:

1. Capability must have `exposeAs: ['api']` and a valid inline `api` block.
2. If a manifest entry exists for `domain.name`, its `operationId`, `method`, `path`, and optional overrides replace the inline projection.
3. Fields not present on the manifest entry fall back to inline values (`stability`, `docs`, etc. use `manifestEntry ?? inline` semantics per field).

A manifest entry for a capability without `exposeAs: ['api']` fails validation.

---

## CLI manifest loading

`plumbus api` commands default to `./api.yaml`. Loading behavior:

| Scenario | Result |
|---|---|
| Default `./api.yaml` missing | Falls back to `buildDefaultManifest()` with a warning |
| Explicit `--manifest path` missing | Error: manifest not found |
| File present but invalid YAML/JSON or schema failure | Error with parse detail — no silent fallback |
| Default path present but invalid | Error — no silent fallback |

```bash
plumbus api validate
plumbus api validate --manifest ./contracts/partner-api.yaml
plumbus api validate --json
```

---

## Path parameters

Path template tokens must correspond to fields on the capability `input` Zod schema. Validation runs on the **resolved** exposure (after manifest merge).

**Valid:**

```yaml
# capability input: z.object({ refundId: z.string(), includeLineItems: z.boolean().optional() })
path: /refunds/{refundId}
```

**Invalid — unmapped param:**

```yaml
path: /refunds/{id}    # input has refundId, not id → manifest.path-param-unmapped
```

**Invalid — duplicate token:**

```yaml
path: /orgs/{orgId}/users/{orgId}    # → manifest.path-param-collision
```

At runtime, `mergePathParamsIntoInput` combines Fastify path params with query (GET) or body (non-GET). Conflicting values for the same key raise a validation error.

---

## Validation error catalog

`plumbus api validate` runs manifest, policy, path-param, fixture, and advisory governance checks. Findings are grouped by category.

### Manifest findings

| Code | Cause | Remediation |
|---|---|---|
| `manifest.capability-not-found` | `capability` key not in app registry | Fix typo or register the capability |
| `manifest.capability-not-exposed` | Capability lacks `exposeAs: ['api']` | Add exposure flag or remove manifest entry |
| `manifest.duplicate-operation-id` | Two entries share `operationId` | Use unique operation IDs |
| `manifest.duplicate-method-path` | Two entries share `method` + `path` | Change method or path |

### Path parameter findings

| Code | Cause | Remediation |
|---|---|---|
| `manifest.path-param-unmapped` | `{token}` not on input schema | Add field to `input` or fix path |
| `manifest.path-param-collision` | Duplicate `{token}` in same path | Use each param name once |

### Policy findings

See [structure-policy.md](./structure-policy.md) for `policy.*` codes.

### Fixture findings

See [test-intent.md](./test-intent.md) for fixture path and schema validation.

---

## Programmatic validation

```typescript
import { parseManifest, validateApiContract } from '@plumbus/api';
import { readFile } from 'node:fs/promises';

const source = await readFile('./api.yaml', 'utf8');
const manifest = parseManifest(source, 'yaml');

const result = await validateApiContract(manifest, capabilities, process.cwd());
// result.ok — true when all finding arrays are empty
// result.manifest, result.policy, result.pathParams, result.fixtures
```

Use in custom CI pipelines alongside the CLI.

---

## Related topics

- [exposure-model.md](./exposure-model.md) — inline `api` metadata and precedence
- [openapi.md](./openapi.md) — how the manifest becomes OpenAPI `servers` and `paths`
- [structure-policy.md](./structure-policy.md) — `policy` block rules
- [governance.md](./governance.md) — advisory rules from `plumbus verify`
