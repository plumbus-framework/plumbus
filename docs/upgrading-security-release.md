# Security release upgrade guide

This is an **explicit migration release**, not a patch update. Core 0.7.x and the coordinated package family below preserve source compatibility where safe while enforcing stricter security behavior. Existing caret ranges such as `^0.6.19` cannot select core 0.7.0; the same minor-line boundary applies to every package, including UI and otherwise unchanged add-ons.

The earlier patch-version plan is superseded and must not be published. New-family packages reject legacy Plumbus peer versions instead of silently mixing runtimes. No security bypass or compatibility flag re-enables vulnerable behavior.

## Packages to publish

| Package | Previous | Prepared |
| --- | --- | --- |
| `@plumbus/ai-bedrock` | 0.1.0 | 0.2.0 |
| `@plumbus/api` | 0.1.4 | 0.2.0 |
| `@plumbus/auth` | 0.1.2 | 0.2.0 |
| `@plumbus/auth-cognito` | 0.1.0 | 0.2.0 |
| `@plumbus/browser-extension` | 0.1.4 | 0.2.0 |
| `@plumbus/chat` | 0.1.12 | 0.2.0 |
| `@plumbus/chat-ui` | 0.1.7 | 0.2.0 |
| `@plumbus/knowledge-base` | 0.1.5 | 0.2.0 |
| `@plumbus/mcp` | 0.5.1 | 0.6.0 |
| `@plumbus/core` | 0.6.19 | 0.7.0 |
| `@plumbus/ui` | 0.7.3 | 0.8.0 |
| `@plumbus/voice` | 0.4.5 | 0.5.0 |
| `@plumbus/voice-deepdub` | 0.1.4 | 0.2.0 |
| `@plumbus/voice-elevenlabs` | 0.1.1 | 0.2.0 |
| `@plumbus/voice-livekit` | 0.1.4 | 0.2.0 |
| `@plumbus/voice-minimax` | 0.1.1 | 0.2.0 |
| `@plumbus/voice-openai` | 0.1.3 | 0.2.0 |
| `@plumbus/voice-soniox` | 0.1.4 | 0.2.0 |

All 18 packages move outside their previous caret range. Some add-ons have only peer/documentation changes, but patch-publishing narrowed peers could break an existing app install. UI moves to 0.8.0 and replaces its direct core dependency with the required core 0.7.x peer, preventing npm from installing a hidden second core alongside an old application runtime. New core peers are `0.7.x`, voice-provider peers are `0.5.x`, and the other canonical ranges are in [peer dependencies](../packages/plumbus-core/instructions/peer-dependencies.md).

## Publication and dependency resolution

- Every package stages under **`next`**, both in `publishConfig` and the publish workflow. No publication or dist-tag promotion is performed by this guide. Promote to `latest` only after all packages and application staging checks pass.
- The workflow checks the release plan before publishing. A release tag must match the core version, initially `v0.7.0`. `pnpm check:release` rejects old-line patch versions, broad or legacy Plumbus peers, and incorrect packed UI dependencies.
- `^0.6.19`, `~0.6.19`, and `0.6.x` stay on the legacy core line; existing lockfiles remain reproducible with `npm ci` / `pnpm install --frozen-lockfile`. Wildcards, `^0`, `latest`, `next`, and explicit new versions are not protected by that minor-line boundary. Dist-tags do not override semver ranges: the version boundary is the protection for old carets.
- Upgrade only the optional packages the app uses, but upgrade every installed Plumbus package to the matching family in one dependency change. For example, select `@plumbus/core@0.7.0`, `@plumbus/voice@0.5.0`, and `@plumbus/voice-livekit@0.2.0` together. Do not use `--force` or `--legacy-peer-deps` to hide mixed-family errors.
- Update application lockfiles, stage the migration, and deploy API/worker processes from the same dependency set. Staying on old versions avoids automatic behavior changes but does not deliver these security fixes.

## Agent instructions

Core 0.7.0 ships agent wiring **v16** and a self-contained consumer checklist at `node_modules/@plumbus/core/instructions/upgrading-security-release.md`. All prepared packages include updated peer and upgrade guidance. After installing them, run `plumbus init --patch` to refresh managed agent instructions while retaining app-owned text. This does not migrate credentials, application code, or stored state.

## Compatibility preserved

- `calculateModelCost()` returns `number` as before, including legacy zero for unknown models. `estimateModelCost()` provides the safe `number | undefined` alternative. Internal ledger/budget code uses the safe estimator.
- Generation results retain numeric `cost`; `costAvailable: false` identifies the compatibility zero for unknown pricing. Tool loops retain numeric `aggregatedCost`, with `aggregatedCostAvailable` indicating whether the total is fully priced. Existing typed consumers compile without changing arithmetic expressions.
- RAG embedding callbacks retain numeric `cost` and add `costAvailable`. Custom ledgers should persist `null` when availability is false. Do not mistake the legacy compatibility zero for confirmed free usage.
- Explicit free-provider costs remain zero/available. Local providers without dollar caps continue working. Configured dollar caps still reject unknown prior spend.
- JWT verification preserves valid issuer-selected finite lifetimes unless `maxTokenLifetimeSeconds` is explicitly configured. Voice token lifetimes remain configurable positive whole seconds, with the existing 90-second default. Non-expiring/nonfinite tokens remain rejected.
- Core constructs per-completion tenant-bound dependencies before calling the original MCP deps-object API, allowing a rolling upgrade without requiring the new factory overload immediately.
- Explicitly configured shared LiveKit rooms keep their names and application authorization requirements. Tenantless defaults keep their prior naming behavior; tenanted defaults are isolated.
- Model prices remain fixed until an explicit manual update. No automatic refresh or promotional lifecycle logic is included.

## Migration-sensitive security changes

| Area | Who needs to act | Required action |
|---|---|---|
| Authentication startup | Apps using an absent/shared/short development signing key | Configure a random key of at least 32 non-padding characters or an application-supplied authenticator/session runtime where supported. Anonymous development stays available; placeholder JWTs never authenticate. |
| JWT claims | Tokens without `exp`, future `nbf`/`iat`, or additional claims overriding reserved fields | Regenerate expiring tokens; pass identity, roles, scopes, tenant, issuer, audience, and expiry through named signing options. |
| SAML | Existing core SAML integrations | Supply the expected outstanding request ID and correct ACS recipient; consume the login transaction. Explicitly opt into `allowUnsolicited` only for intentional IdP-initiated/bearer flows. Keep replay storage long-lived and shared where needed. |
| MCP HTTP | Clients that initialize/list tools without credentials | Send valid Authorization headers on every transport request. Public discovery is still separately configurable. |
| Flows | Active legacy rows without a valid auth snapshot | Inspect stored snapshots before rollout. Restart/recover from a verified initiating identity after reviewing prior effects; never fill missing snapshots with worker/system privileges. |
| RAG | Apps relying on omitted tenant filters for cross-tenant retrieval | Ingest documents with the intended tenant identity. Missing tenant context now accesses only unscoped documents. Use app-owned, explicitly authorized sharing designs instead of accidental all-tenant retrieval. |
| Audit | Apps with missing audit wiring, invalid outcomes, or unavailable audit storage | Supply a working audit service and existing `audit_records` table. Use `success`, `failure`, or `denied`. Permanent persistence errors surface; they do not reverse already-committed or external effects. Protect retries with application idempotency. |
| Voice WebSocket | Clients sending large messages or bursts | Split audio to ≤64 KiB and control messages to ≤16 KiB; pending input is bounded to 256 KiB. Use returned room names rather than reconstructing old tenant-agnostic names. |
| Errors/cookies | Clients parsing private error strings or relying on duplicate cookie names | Use stable error codes and server logs; clear ambiguous duplicate cookies. |
| Generated files | Projects using traversal-like names or symlinked write destinations | Use safe single-segment names and ordinary output directories. |
| Partner OpenAPI | Manifests advertising query-string API keys | Declare authentication actually implemented by the runtime; query API-key schemes cannot be exported. |

No database schema changes are introduced in this release. Existing tables and migrations must already be current for the installed framework line. Stored invalid flow state requires operational review, not a blanket SQL rewrite.

## Deployment gate

Before deploying an application:

1. Publish/install the prepared package versions and update its lockfile; verify UI shares the application's new core through its required peer.
2. Check the applicable rows above against the application's credentials, SAML configuration, active flow rows, audit storage, and voice clients.
3. Run application-level authentication, RAG isolation, job/flow, and voice smoke tests in staging. The framework suite cannot establish the state of a consumer production database or identity provider.
4. Deploy API and worker processes together, then monitor authentication failures, rejected legacy flows, audit persistence errors, and budget/voice-limit denials.

## Release-preparation checks

1. Run `pnpm check:release`, `pnpm test:release`, and the four repository gates: lint, format checking, typechecking, and tests.
2. Pack all 18 packages. Check packed metadata with `node scripts/check-release-boundaries.mjs --packed-manifests <manifest-map.json>`; UI must require the shared core 0.7.x peer with no nested core dependency; all internal peers must stay within the new family.
3. Install the complete tarball family in a clean npm consumer using `--omit=dev --ignore-scripts`. Verify SDK imports and `npm ls` without bypassing peer errors. Also test core alone, core with UI, and core with voice/provider packages.
4. Verify that legacy core mixed with a new add-on, new core mixed with an old add-on, and legacy voice mixed with a new provider are rejected by npm. Legacy caret selection must remain on old versions when both families are available.
5. Run consumer staging authentication, RAG, task/flow, audit, and voice checks before promoting dist-tags or deploying.

These checks do not constitute a production migration. Application-specific credentials, databases, identity providers, and voice integrations still need staging validation.
