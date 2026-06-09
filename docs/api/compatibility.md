# API Compatibility

Before publishing a new partner API version, compare the current generated OpenAPI spec against a previously published baseline. `plumbus api diff` classifies changes as **breaking** or **non-breaking** and exits with code `1` when breaking changes are detected — suitable for CI gates.

**Previous:** [structure-policy.md](./structure-policy.md) · **Next:** [governance.md](./governance.md)

---

## When to run diff

Run compatibility diff when:

- You are about to release a new API version to partners.
- CI should block merges that remove operations or tighten schemas without a major version bump.
- You maintain a committed `published/openapi-v1.json` (or YAML) as the contract baseline.

Skip diff when:

- You have no external consumers yet (early development).
- You intentionally ship breaking changes and have bumped `basePath` or communicated a major version to partners.

---

## CLI usage

```bash
# Compare current contract against published baseline
plumbus api diff --against ./published/openapi-v1.json

# YAML baselines supported
plumbus api diff --against ./published/openapi-v1.yaml

# Machine-readable output for CI dashboards
plumbus api diff --against ./published/openapi-v1.json --json

# Custom manifest
plumbus api diff --manifest ./api.yaml --against ./published/openapi-v1.json
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | No breaking changes (non-breaking changes may be present) |
| `1` | One or more breaking changes detected |

---

## What gets compared

`diffOpenApi(baseline, current)` walks operations by `operationId` and compares:

- HTTP method and path
- Request schema (body + query parameters)
- Response `data` schema inside the success envelope
- OAuth scopes per operation
- Error response shape (presence of standard status codes)
- `x-plumbus-test` vendor extension (removing test behavior is breaking)

Operations are keyed by `operationId` from the OpenAPI document. Renaming an operation ID appears as remove + add.

---

## Breaking changes

These require a major version bump or partner communication:

| Kind | Example |
|---|---|
| `removed-operation` | `getRefund` no longer in spec |
| `changed-method` | `getRefund` was `GET`, now `POST` |
| `changed-path` | Path changed from `/refunds/{id}` to `/refunds/{refundId}` |
| `removed-test-behavior` | `x-plumbus-test` removed from operation |
| `removed-response-field` | `amount` removed from response `data` |
| `changed-response-type` | `amount` changed from `number` to `string` |
| `added-required-input` | New required request field `reason` |
| `request-field-became-required` | Optional `includeLineItems` now required |
| `enum-value-removed` | `status` enum lost value `pending` |
| `tightened-scopes` | New scope `refunds:admin` required on operation |
| `changed-error-shape` | Standard error status codes added/removed |

### Example: breaking request change

**v1 baseline** — optional `note` on approve:

```json
{
  "properties": { "reason": { "type": "string" } },
  "required": ["reason"]
}
```

**v2 current** — added required `note`:

```
BREAKING: request field "note" added to approveRefund (required)
```

Partners sending the v1 payload without `note` would fail validation.

---

## Non-breaking changes

Safe without a major version bump (still worth documenting in release notes):

| Kind | Example |
|---|---|
| `added-operation` | New `listRefunds` endpoint |
| `added-optional-input` | New optional query param `includeLineItems` |
| `added-optional-response-field` | Response adds optional `metadata` object |
| `added-required-response-field` | New required field on response (clients ignore unknown fields) |
| `response-field-became-required` | Field was already always present; now marked required in schema |
| `removed-request-field` | Removed optional input field partners may not have used |
| `deprecated-operation` | `deprecated: true` added — operation still callable |

### Example: non-breaking response change

**v1:**

```json
{ "properties": { "id": { "type": "string" }, "amount": { "type": "number" } } }
```

**v2** — adds optional `currency`:

```
NON-BREAKING: response field "currency" added to getRefund
```

---

## Programmatic diff

```typescript
import {
  diffOpenApi,
  generateOpenApi,
  parseOpenApiDocument,
  buildDefaultManifest,
} from '@plumbus/api';
import { readFile } from 'node:fs/promises';

const manifest = buildDefaultManifest(capabilities);
const current = generateOpenApi(capabilities, manifest);
const baseline = parseOpenApiDocument(
  await readFile('./published/openapi-v1.json', 'utf8'),
);

const { breaking, nonBreaking } = diffOpenApi(baseline, current);

if (breaking.length > 0) {
  console.error('Breaking changes:', breaking);
  process.exit(1);
}
```

---

## CI integration workflow

A typical release pipeline:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Validate contract (manifest, policy, fixtures, path params)
plumbus api validate

# 2. Validate test fixtures if used
plumbus api test-fixtures validate

# 3. Generate current spec
plumbus api generate openapi --out ./dist/openapi.json

# 4. Diff against published baseline
plumbus api diff --against ./published/openapi-v1.json

# 5. On successful release, update baseline
# cp ./dist/openapi.json ./published/openapi-v1.json
```

GitHub Actions example step:

```yaml
- name: API compatibility check
  run: |
    pnpm exec plumbus api validate
    pnpm exec plumbus api generate openapi --out ./dist/openapi.json
    pnpm exec plumbus api diff --against ./published/openapi-v1.json --json
```

On breaking changes, bump `basePath` (e.g. `/api/v2`), update `published/openapi-v2.json`, and follow your deprecation policy for v1 sunset.

---

## Limitations

The diff compares OpenAPI schema structure — not handler behavior. A change that preserves schemas but alters business logic is invisible to diff. Keep Vitest coverage on capability handlers.

Removing an optional request field is classified non-breaking even if partners relied on it — use deprecation metadata and communication for behavioral sunsets.

---

## Related topics

- [openapi.md](./openapi.md) — generating the current spec
- [manifest.md](./manifest.md) — version via `basePath`
- [exposure-model.md](./exposure-model.md) — `stability: deprecated` and `deprecation.replacement`
- [overview.md](./overview.md) — end-to-end publish workflow
