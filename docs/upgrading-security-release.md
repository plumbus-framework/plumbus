# Security release upgrade guide

This release prepares the security-review fixes for publishing. It preserves the released numeric cost API types and configurable finite token lifetimes, but intentionally rejects insecure credentials, invalid authorization state, and oversized input. It is a security-patch release with migration-sensitive runtime behavior, not an unconditional drop-in deployment.

## Packages to publish

| Package | Previous | Prepared |
|---|---|---|
| `@plumbus/core` | 0.6.19 | 0.6.20 |
| `@plumbus/ui` | 0.7.3 | 0.7.4 |
| `@plumbus/ai-bedrock` | 0.1.0 | 0.1.1 |
| `@plumbus/api` | 0.1.4 | 0.1.5 |
| `@plumbus/chat` | 0.1.12 | 0.1.13 |
| `@plumbus/mcp` | 0.5.1 | 0.5.2 |
| `@plumbus/voice` | 0.4.5 | 0.4.6 |
| `@plumbus/voice-livekit` | 0.1.4 | 0.1.5 |

Each package has a versioned changelog entry. The UI bump updates its packed direct dependency on core. Other add-ons are unchanged. Existing canonical peer ranges remain unchanged; install the full set of **used** packages above to obtain all security fixes. Peer-range satisfaction alone does not mean an older package contains those fixes.

Use the existing publish workflow: MCP and Bedrock publish before core, then the remaining packages; voice publishes before its LiveKit add-on, and core before UI. Roll out applications only after the complete set of used package versions is available. Update application lockfiles and deploy API/worker processes from the same dependency set. No publication, merge, or production deployment is performed by this guide.

## Agent instructions

Core 0.6.20 ships agent wiring **v15** and a self-contained consumer checklist at `node_modules/@plumbus/core/instructions/upgrading-security-release.md`. The eight prepared packages include updated agent guidance. After installing them, run `plumbus init --patch` in the consumer app to refresh managed Copilot/Cursor/AGENTS/CLAUDE blocks while retaining app-owned text. This does not migrate credentials or application state.

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

1. Publish/install the prepared package versions and update its lockfile; verify the packed UI dependency resolves the new core.
2. Check the applicable rows above against the application's credentials, SAML configuration, active flow rows, audit storage, and voice clients.
3. Run application-level authentication, RAG isolation, job/flow, and voice smoke tests in staging. The framework suite cannot establish the state of a consumer production database or identity provider.
4. Deploy API and worker processes together, then monitor authentication failures, rejected legacy flows, audit persistence errors, and budget/voice-limit denials.

Release-preparation checks:

- Final `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test` all passed, including the legacy consumer type fixture and 2,170 core tests.

- Versioned changelogs and unused registry version numbers were verified for all eight prepared packages.
- All eight rebuilt tarballs contain their declared entry points, updated instruction files, and matching changelogs; core includes the packaged security checklist and compiled wiring v15. Packed UI depends on core 0.6.20; no runtime dependency retains a `workspace:` reference.
- A fresh `npm install --omit=dev --ignore-scripts` from the local tarballs passed. `npm ls` reports one core 0.6.20 and one voice 0.4.6 without peer errors.
- Every packed SDK imported successfully. A packed-consumer smoke test verified legacy numeric costs, unknown-cost budget enforcement, tool-loop availability, and configurable JWT lifetime checks.
- The publish workflow now runs lint, format checking, typechecking, and tests before publication. It is triggered by `v*` tags; no tag or publication was created in this preparation.

The install check disables dependency lifecycle scripts and does not exercise live providers. Application staging and database/identity-provider checks remain necessary. The prepared changes are local until committed and published.
