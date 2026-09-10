# Security release — consumer agent checklist

Read this before upgrading an app to `@plumbus/core` **0.6.20**. This guide ships inside the package; it does not require a checkout of the framework repository.

## Keep the framework architecture

Implement app business logic through Plumbus capabilities, flows, entities, events, prompts, and `ctx.*`. Fix configuration or use documented extension points when a security check rejects a request. Do not bypass authorization, install a parallel data layer, fabricate worker/system identities, or restore public development signing keys to make an upgrade pass.

## Package and wiring versions

| Installed package | Security release |
|---|---|
| `@plumbus/core` | 0.6.20 |
| `@plumbus/ui` | 0.7.4 |
| `@plumbus/ai-bedrock` | 0.1.1 |
| `@plumbus/api` | 0.1.5 |
| `@plumbus/chat` | 0.1.13 |
| `@plumbus/mcp` | 0.5.2 |
| `@plumbus/voice` | 0.4.6 |
| `@plumbus/voice-livekit` | 0.1.5 |

Update only the optional packages the app already uses. Do not install every add-on. Preserve canonical peer literals from [peer-dependencies.md](./peer-dependencies.md); coarse peer compatibility does not establish that an older package includes the security fixes.

After installing the release, run these commands from the app root:

```bash
plumbus init --patch
plumbus doctor
plumbus test
```

Agent wiring is **version 15**. `--patch` refreshes only the managed wiring block and preserves app-owned instructions. Do not use `--force` to erase custom guidance. It does not migrate app code, credentials, or stored flow state.

## Apply the relevant migration checks

- **Auth:** configure a random JWT secret with at least 32 non-padding characters, or use the app's documented authenticator/session runtime. Development without credentials is anonymous. Tokens need a finite future `exp`; future `nbf`/`iat` fail verification. Pass reserved signing claims through named `signJwt` options. Valid issuer-selected lifetimes remain supported; `maxTokenLifetimeSeconds` is opt-in.
- **SAML:** pass `processSamlResponse(encoded, expectedRequestId)` the outstanding request ID and configure the ACS `recipient`. Consume the login transaction. Use `allowUnsolicited` only for an intentional IdP-initiated integration; retain replay protection and appropriate shared storage. Do not disable validation to accept a previously replayable assertion.
- **MCP:** authenticate every HTTP transport request, including initialization/listing. Invalid explicit headers never fall back to `PLUMBUS_MCP_TOKEN`. The CLI currently reads environment config, not `plumbus.config.*`: use `AUTH_SECRET` for CLI JWTs, or application-owned runtime wiring for an opaque agent map. Stdio can use the map's environment token; public discovery is separate.
- **Flows:** inspect active legacy executions for missing/invalid auth snapshots. Recover only from a verified initiating identity after reviewing prior effects. Never populate snapshots with `roles: ['system']` to bypass rejection.
- **RAG:** ingest tenant-owned documents with their tenant. `ctx.ai.retrieve` uses the executing identity; a missing tenant accesses only unscoped documents. Custom wrappers around framework AI services must preserve `withContext`.
- **Audit:** supply an audit service and working audit storage. Use `success`, `failure`, or `denied` outcomes. Permanent failures propagate; they do not roll back already-committed/external effects. Explicit opt-outs and post-commit limitations are not compliance guarantees. Use idempotency and documented durable audit extension points when stronger guarantees are required.
- **Voice:** send audio messages ≤64 KiB and JSON control messages ≤16 KiB, with ≤256 KiB pending input. Use returned room names. Explicit shared rooms remain app-authorized. Session-token secrets require 32 non-padding characters; configured finite positive lifetimes remain valid (default 90 seconds). Configure session budgets for production media workloads.
- **API/errors/scaffolds:** replace unsupported query-string API-key manifests with implemented authentication; use stable error codes rather than private role/scope text; clear ambiguous duplicate cookies; use safe names and non-symlink write destinations.

## Preserve free versus unknown cost

Numeric APIs remain source-compatible: `calculateModelCost()`, generation `cost`, tool-loop `aggregatedCost`, and RAG embedding callback `cost` remain numbers. A legacy zero is **not** proof of free usage. Use `estimateModelCost()` for an unknown-aware estimate, and check `costAvailable` / `aggregatedCostAvailable`; custom ledgers must store `null` when availability is false. Framework budget accounting already does this.

Explicit zero-cost providers remain supported. Unpriced local providers work without dollar caps. Do not invent a zero price to bypass a configured spending limit. Catalog prices remain fixed until an explicit manual update; do not add automatic refresh or promotional lifecycle logic.

## Verify the app

Run staging checks for the app's authentication/SAML, tenant isolation, jobs/flows, audit storage, and voice clients. No new database schema is introduced by this release, but existing migrations must be current. Update API and worker dependency sets together. Package tests alone cannot verify a consumer database or identity provider.
