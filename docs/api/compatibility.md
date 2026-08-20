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

# Generate the current spec in the same document dialect as the baseline
plumbus api diff --against ./published/openapi-v1.json --openapi-version 3.1.0
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | No breaking changes (non-breaking changes may be present) |
| `1` | One or more breaking changes detected |

---

## What gets compared

`diffOpenApi(baseline, current)` compares the two documents' `openapi` version, then walks operations by `operationId` and compares:

- HTTP method and path
- Request schema (body + query parameters)
- Response `data` schema inside the success envelope
- OAuth scopes per operation
- Error response shape (presence of standard status codes)
- `x-plumbus-test` vendor extension (removing test behavior is breaking)

Operations are keyed by `operationId` from the OpenAPI document. Renaming an operation ID appears as remove + add.

Only operation keys (`get`, `put`, `post`, `delete`, `options`, `head`, `patch`, `trace`) are read from a path item — path-level `summary`, `description`, `servers`, and shared `parameters` are metadata, not operations, so moving a shared parameter into the operation is not reported as a removal.

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
| `changed-request-type` | `refundId` changed from `string` to `number` in the request |
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
| `changed-openapi-version` | Document re-emitted as OpenAPI `3.1.0` instead of `3.0.3` |

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

## Cross-version diff

A baseline published as OpenAPI 3.0.3 can be compared against a current spec generated as 3.1.0, in either direction. Two things happen.

### 1. The version change is reported, and it is not breaking

```
NON-BREAKING: OpenAPI document version changed 3.0.3 → 3.1.0 (document dialect only —
the wire contract is unchanged; regenerate clients with tooling that reads 3.1.0)
```

The reasoning, because it is a judgement call worth stating:

- **The wire contract is unchanged.** The `openapi` field names the *document dialect*, not the contract the server serves. Re-emitting the same capabilities at 3.1.0 leaves every path, method, status code, security requirement, and JSON payload identical — the same handler serves both documents. No partner request that worked against the 3.0 document stops working. That is what "breaking" means here, so the change is not breaking, and `plumbus api diff` still exits `0`.
- **The document dialect is not unchanged.** OpenAPI 3.1 is JSON Schema 2020-12: nullability moves from the `nullable` keyword to a `null` member of a `type` array, a single permitted value may be `const` rather than a one-member `enum`, and a client generator or API portal pinned to 3.0 may refuse the document outright. That is a real cost — borne by consumers of the *spec*, not callers of the *API* — so it is reported rather than dropped, and belongs in release notes alongside the other non-breaking entries.

If you would rather gate on it, read the `--json` output and fail your pipeline on `kind: "changed-openapi-version"`. The diff will not make that decision for you.

### 2. Dialect differences are not mistaken for schema changes

The diff normalizes the two spellings before comparing, so a pure re-emission produces the version entry and nothing else:

| OpenAPI 3.0 | OpenAPI 3.1 | Treated as |
|---|---|---|
| `{ type: 'string', nullable: true }` | `{ type: ['string', 'null'] }` | the same schema |
| `{ type: 'object', nullable: true, properties: … }` | `{ anyOf: [{ type: 'object', properties: … }, { type: 'null' }] }` | the same schema |
| `{ type: 'boolean', enum: [true] }` | `{ type: 'boolean', const: true }` | the same permitted value |

Without that normalization every nullable field would surface as a breaking `changed-response-type` on the day you switch dialects — a false alarm that trains teams to ignore the gate.

A genuine change made in the same release is still caught: dropping a response field while bumping the document version reports both `removed-response-field` (breaking) and `changed-openapi-version` (non-breaking).

### Keeping CI quiet

Give `plumbus api diff` the same dialect as the baseline it compares against, and the version entry disappears:

```bash
plumbus api diff --against ./published/openapi-v1.json --openapi-version 3.1.0
```

Switch the baseline and the flag together in one release, and note the dialect change for partners who generate clients from the document.

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

Nullability itself is not classified. Because 3.0 and 3.1 spell it differently, both spellings normalize to the same schema, and a field that gains or loses `null` is not reported in either direction. Treat a field turning nullable as a documented behavioral change.

Only `paths` is walked. OpenAPI 3.1 documents may omit `paths` entirely and describe `webhooks` or `components` alone; such a document diffs cleanly rather than throwing, but its webhooks are not compared.

---

## Related topics

- [openapi.md](./openapi.md) — generating the current spec
- [manifest.md](./manifest.md) — version via `basePath`
- [exposure-model.md](./exposure-model.md) — `stability: deprecated` and `deprecation.replacement`
- [overview.md](./overview.md) — end-to-end publish workflow
