# OpenAPI Export

`plumbus api generate openapi` produces a rich OpenAPI 3.0.3 specification from capability Zod schemas and the resolved API manifest. The generated spec is the **canonical partner contract** — distinct from the thin convention spec emitted by `plumbus generate`.

Because schemas come directly from Zod, the spec cannot drift from runtime validation.

**Previous:** [manifest.md](./manifest.md) · **Next:** [test-intent.md](./test-intent.md)

---

## When to generate partner OpenAPI

Generate and publish partner OpenAPI when:

- External integrators need machine-readable contracts for client generation.
- CI runs compatibility diff against a published baseline (see [compatibility](./compatibility.md)).
- API portals or documentation sites ingest OpenAPI.

Use `plumbus generate` OpenAPI only for app-internal convention routes — it is a thin projection without manifest metadata, envelopes, or partner extensions.

---

## CLI usage

```bash
# JSON (default)
plumbus api generate openapi --out ./dist/openapi.json

# YAML
plumbus api generate openapi --out ./dist/openapi.yaml --format yaml

# Custom manifest path
plumbus api generate openapi --manifest ./contracts/partner.yaml --out ./dist/openapi.json
```

All `plumbus api` commands accept `--manifest <path>` (default `./api.yaml`).

---

## Programmatic generation

```typescript
import {
  generateOpenApi,
  serializeOpenApiDocument,
  buildDefaultManifest,
} from '@plumbus/api';

const manifest = parsedManifest ?? buildDefaultManifest(capabilities);
const doc = generateOpenApi(capabilities, manifest);
const json = serializeOpenApiDocument(doc, 'json');
const yaml = serializeOpenApiDocument(doc, 'yaml');
```

---

## Servers and paths model

OpenAPI separates the API prefix from individual route paths to avoid double-prefix bugs:

| OpenAPI field | Source | Example |
|---|---|---|
| `servers[0].url` | `manifest.basePath` | `/api/v1` |
| `paths` keys | Resolved `operation.path` only | `/refunds/{refundId}` |

A partner calls `GET /api/v1/refunds/ref-123` — the server URL plus the path key. Paths are **not** prefixed with `basePath` again inside `paths`.

`info.title` comes from `manifest.name`. `info.version` comes from `apiVersionFromManifest(manifest)`.

---

## Operation structure

Each API-exposed capability with a manifest entry (or inline default) becomes one OpenAPI operation:

```yaml
/refunds/{refundId}:
  get:
    operationId: getRefund
    summary: Fetch a refund by id
    tags: [billing]
    parameters:
      - name: refundId
        in: path
        required: true
        schema: { type: string }
    responses:
      '200':
        description: Successful response
        content:
          application/json:
            schema:
              allOf:
                - $ref: '#/components/schemas/ApiSuccessEnvelope'
                - type: object
                  properties:
                    data:
                      type: object
                      properties:
                        id: { type: string }
                        amount: { type: number }
      '400': { $ref: '#/components/responses/ApiError' }
      # 401, 403, 404, 409, 500 similarly
```

### Per-field GET parameters

For `GET` operations, non-path input fields become **query parameters** — one OpenAPI parameter per Zod field, with types inferred from the schema.

Path-bound fields are excluded from query parameters (they appear only as `in: path` parameters).

### Request body without path fields

For non-`GET` methods, `requestBody` is required. The JSON schema includes all input fields **except** those bound as path parameters — the same rule as GET query params.

Example: `input: { refundId, reason }` on `POST /refunds/{refundId}/approve` produces a body schema with `{ reason }` only.

---

## Schema generation

Request and response schemas are produced via `zod-to-json-schema` with OpenAPI 3 target (`zodToOpenApiSchema`). This preserves:

- `min` / `max` on numbers
- `pattern` on strings
- `format` (e.g. `email`, `uuid`)
- Enum values
- Nested objects and arrays

Unlike Anthropic structured-output conversion, there are no artificial limits on schema depth for OpenAPI export.

---

## Security schemes

When any operation declares scopes (from resolved `api.auth.scopes` or `access.scopes`), OpenAPI emits an OAuth2 security scheme:

```yaml
components:
  securitySchemes:
    oauth2:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: /oauth/token
          scopes:
            refunds:read: refunds:read
            refunds:write: refunds:write
```

Per-operation `security` references `oauth2` with the operation's required scope list — not an undeclared scheme name.

If no scopes are declared but `identity.defaultAuth` is set (and not `oauth2`), a `bearerAuth` HTTP scheme is emitted instead.

**Note:** Token URL and gateway configuration are app-owned. The generated scheme documents scope names for partners; wire your actual OAuth server in infrastructure.

---

## Envelope components

All operations reference shared envelope schemas in `components.schemas`:

### `ApiSuccessEnvelope`

```yaml
type: object
required: [ok, data, meta]
properties:
  ok: { type: boolean, enum: [true] }
  data: { type: object }
  meta:
    type: object
    properties:
      requestId: { type: string }
      apiVersion: { type: string }
```

The `200` response uses `allOf` to combine the envelope with operation-specific `data` shape.

### `ApiErrorEnvelope`

```yaml
type: object
required: [ok, error, meta]
properties:
  ok: { type: boolean, enum: [false] }
  error:
    type: object
    required: [code, message, requestId]
    properties:
      code: { type: string }
      message: { type: string }
      details:
        type: array
        items:
          type: object
          properties:
            path: { type: string }
            message: { type: string }
      requestId: { type: string }
  meta:
    type: object
    properties:
      apiVersion: { type: string }
```

Standard error responses (`400`, `401`, `403`, `404`, `409`, `500`) all reference `ApiErrorEnvelope`.

---

## Vendor extensions

Operations with idempotency or test config include Plumbus-specific extensions for tooling:

| Extension | Content |
|---|---|
| `x-plumbus-idempotency` | `{ required, header, ttl? }` from resolved exposure |
| `x-plumbus-test` | `{ enabled, modes, defaultMode?, safeReply? }` from resolved exposure |

These appear in generated specs and are compared during compatibility diff (removing test behavior is breaking).

---

## Duplicate registrations

If two capabilities resolve to the same `method` + `path`, generation logs a console warning:

```
[plumbus/api] Duplicate method+path GET /refunds/{refundId} — later operation "getRefundV2" overwrites earlier definition
```

The last operation wins in the output document. `plumbus api validate` also flags `manifest.duplicate-method-path` when duplicates appear in the manifest itself.

---

## Markdown docs

Generate human-readable reference pages alongside OpenAPI:

```bash
plumbus api generate docs --out ./dist/api-docs
```

```typescript
import { generateApiDocs } from '@plumbus/api';

const pages = generateApiDocs(capabilities, manifest);
// Map<operationId, markdown string>
```

Each page covers one operation with method, path, scopes, and schema summary.

---

## Related topics

- [manifest.md](./manifest.md) — manifest fields that feed OpenAPI metadata
- [compatibility.md](./compatibility.md) — diffing generated specs in CI
- [exposure-model.md](./exposure-model.md) — scopes, idempotency, stability
- [test-intent.md](./test-intent.md) — `x-plumbus-test` extension semantics
