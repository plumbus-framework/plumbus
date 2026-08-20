# OpenAPI Export

`plumbus api generate openapi` produces a rich OpenAPI specification from capability Zod schemas and the resolved API manifest — **3.0.3 by default, 3.1.0 on request**. The generated spec is the **canonical partner contract** — distinct from the thin convention spec emitted by `plumbus generate`.

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

# OpenAPI 3.1.0 instead of the 3.0.3 default
plumbus api generate openapi --out ./dist/openapi.json --openapi-version 3.1.0

# Custom manifest path
plumbus api generate openapi --manifest ./contracts/partner.yaml --out ./dist/openapi.json
```

Most `plumbus api` commands accept `--manifest <path>` (default `./api.yaml`). `plumbus api test-fixtures validate` always uses the default manifest loader (`./api.yaml`) and does not accept `--manifest`.

---

## Document version

| Flag | Emits | When to use |
|---|---|---|
| *(omitted)* | OpenAPI **3.0.3** | Default. Widest tooling support; published baselines do not move when you upgrade `@plumbus/api`. |
| `--openapi-version 3.0.3` | OpenAPI 3.0.3 | Explicit form of the default — pin it in CI so an upgrade cannot change the dialect silently. |
| `--openapi-version 3.1.0` | OpenAPI **3.1.0** | Your portal or client generator wants the JSON Schema 2020-12 dialect — where nullability is a `null` member of a `type` array rather than the 3.0-only `nullable` keyword. |

Any other value is rejected before generation runs:

```
Unsupported OpenAPI version "3.2.0". Supported: 3.0.3, 3.1.0.
```

The document version is a **choice about the document, not about the API**. Both versions describe the same routes, methods, status codes, security requirements and JSON payloads; the same handler serves both. Switching does not change what partners send or receive — see [compatibility.md](./compatibility.md#cross-version-diff) for how the diff classifies the switch.

`--openapi-version` is available on `plumbus api diff` as well, so CI can generate the current spec in the same dialect as its published baseline:

```bash
plumbus api diff --against ./published/openapi-v1.json --openapi-version 3.1.0
```

Generation never patches the `openapi` field on its own. If the installed `@plumbus/api` is older than 3.1 support it emits 3.0.3, and the CLI fails rather than writing a document labelled 3.1.0 with 3.0-shaped schemas:

```
Requested OpenAPI 3.1.0, but the installed @plumbus/api emitted 3.0.3. Upgrade @plumbus/api to a release that supports OpenAPI 3.1.0 emission.
```

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

// Opt into the 3.1.0 document dialect — what `--openapi-version 3.1.0` passes.
const doc31 = generateOpenApi(capabilities, manifest, { version: '3.1.0' });
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

Declare explicit schemes in `api.yaml` under `securitySchemes`. OpenAPI export maps them literally — it does **not** invent token endpoints.

```yaml
components:
  securitySchemes:
    partnerOAuth:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://identity.example.com/oauth2/token
          scopes:
            refunds:read: Read refunds
            refunds:write: Write refunds
```

OAuth2 operations attach scopes to the named scheme. HTTP bearer and API key schemes carry required scopes on the operation extension **`x-plumbus-required-scopes`** (OpenAPI has no standard scope field for non-OAuth schemes).

Legacy manifests with `identity.defaultAuth` (no `securitySchemes`) export an `http` **`bearer`** scheme plus `x-plumbus-required-scopes` on each operation. `plumbus api validate` warns but does not fail on this shape.

**Browser session apps:** When the runtime uses `@plumbus/auth`, partners calling from server-side integrations still use bearer or client-credentials as documented. First-party SPAs use cookie sessions — document that separately in `authentication.md` generated docs; OpenAPI security schemes describe machine-to-machine access, not the `/auth/session` CSRF contract.

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
// Map<relative file path, markdown> — keys include overview.md, authentication.md, endpoints/{operationId}.md
```

Pages include `overview.md`, `authentication.md`, and one `endpoints/{operationId}.md` per operation.

---

## Related topics

- [manifest.md](./manifest.md) — manifest fields that feed OpenAPI metadata
- [compatibility.md](./compatibility.md) — diffing generated specs in CI
- [exposure-model.md](./exposure-model.md) — scopes, idempotency, stability
- [test-intent.md](./test-intent.md) — `x-plumbus-test` extension semantics
