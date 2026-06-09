# Manifest, validation, and CLI

Use this file when maintaining `api.yaml`, running contract validation in CI, or generating partner artifacts.

## `api.yaml` manifest

```yaml
apiVersion: plumbus.dev/v1
name: partner-api
basePath: /api/v1
version: "1.0.0"

expose:
  - capability: billing.getRefund
    operationId: getRefund
    method: GET
    path: /refunds/{refundId}
    stability: stable
    auth:
      scopes: [refunds:read]
```

**Precedence:** when `./api.yaml` exists, manifest entries override inline `api` metadata for the same capability. When the manifest is missing, the CLI and runtime fall back to inline metadata via `buildDefaultManifest()`. An explicit `--manifest <path>` that is missing or invalid fails with a clear error.

**Structure policy:** `plumbus api validate` checks naming, path shape, stability tags, and related conventions. Findings are reported in the CLI output and in `validateApiContract` results.

## CLI commands

Commands ship in `@plumbus/core` and dynamically import `@plumbus/api`:

| Command | Purpose |
|---|---|
| `plumbus api validate` | Manifest, policy, path params, fixtures, advisory governance |
| `plumbus api generate openapi --out <file>` | Write OpenAPI JSON or YAML (`--format yaml`) |
| `plumbus api generate docs --out <dir>` | Write Markdown API reference per operation |
| `plumbus api diff --against <file>` | Compare current spec to a published baseline; exits non-zero on breaking changes |
| `plumbus api test-fixtures validate` | Validate test-intent fixture files against capability output schemas |

All commands accept `--manifest <path>` (default `./api.yaml`) and `--json` where applicable.

## Programmatic validation

```ts
import { validateApiContract } from "@plumbus/api";

const result = await validateApiContract({
  capabilities,
  manifestPath: "./api.yaml",
  appRoot: process.cwd(),
});
// result.ok, result.findings, result.manifest
```

Use in CI alongside `plumbus api validate` for custom pipelines.

## OpenAPI generation

```bash
plumbus api generate openapi --out ./dist/openapi.json
plumbus api generate openapi --out ./dist/openapi.yaml --format yaml
```

```ts
import { generateOpenApi, serializeOpenApiDocument } from "@plumbus/api";

const doc = generateOpenApi({ capabilities, manifest });
const json = serializeOpenApiDocument(doc, "json");
```

OpenAPI is generated from Zod input/output schemas and manifest metadata. This is the **canonical partner spec** — distinct from the thin convention spec from `plumbus generate`.

## Markdown docs

```bash
plumbus api generate docs --out ./dist/api-docs
```

```ts
import { generateApiDocs } from "@plumbus/api";

const pages = generateApiDocs({ capabilities, manifest });
```

## Compatibility diff

```bash
plumbus api diff --against ./published/openapi-v1.json
```

```ts
import { diffOpenApi, generateOpenApi, parseOpenApiDocument } from "@plumbus/api";

const current = generateOpenApi({ capabilities, manifest });
const baseline = parseOpenApiDocument(fs.readFileSync("published/openapi-v1.json", "utf8"));
const diff = diffOpenApi(baseline, current);
// diff.breaking, diff.nonBreaking
```

Run in CI before release. Breaking changes should bump API version or follow your deprecation policy.

## Governance

Advisory API rules also run in `plumbus verify` when capabilities expose the API surface. Warnings only — never hard blocks. Run `plumbus verify` or `plumbus api validate` to see rule codes and messages.
