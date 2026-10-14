# Upgrading to core 0.9 (beta)

Core 0.9 is the beta line of the next coordinated release family. It carries breaking changes, so every package moves to a new minor line and the family is first published as **`-beta.N` prereleases under a branch-named npm dist-tag** (`plumbus-next` while it is tagged from that branch).

The 0.8 numbers now belong to the stable **stabilization family** published from `main` to npm `latest`: core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1 and the other add-ons 0.3.0 (see [the stabilization guide](./upgrading-stabilization.md)). The beta line, published until now as core `0.8.0-beta.N`, therefore moved up one minor: core **0.9**, UI **0.10**, MCP **0.8**, voice **0.7** and the other add-ons **0.4**, still under the `plumbus-next` dist-tag. This release is prepared on **2026-10-14** as repository release **`v0.9.0-beta.0`**. `latest` keeps pointing at the stable 0.8 family until the beta is promoted.

Core 0.9.0-beta.0 contains everything in the 0.8.0-beta.N line plus every stable change merged from `main`: the core 0.8.0 stabilization (PLB-01 to PLB-10), core 0.8.1, auth 0.3.1 and the Vitest 5.0.4 toolchain. See [Included in v0.9.0-beta.0](#included-in-v090-beta0).

## Which upgrade applies

### From a 0.8.0-beta.N install

Move every installed Plumbus package to its 0.9 beta in one dependency change (see [Installing the beta](#installing-the-beta)); never mix `0.8.0-beta.N` and `0.9.0-beta.N` packages. The beta-specific breaking changes in [Breaking changes in this family](#breaking-changes-in-this-family) are the ones you already applied for the 0.8 beta. The stabilization changes are new to the beta line with this release, so also follow the [stabilization guide](./upgrading-stabilization.md):

- **Vitest 5.0.4 and the Node floor.** Core ships Vitest 5.0.4 and Vite `^7.3.7` and requires Node `^22.12.0 || ^24.0.0 || >=26.0.0`. Update developer machines, CI and container images, and app-owned E2E configs; see the [Vitest migration guide](./upgrading-vitest.md). `plumbus doctor` reports an unsupported Node.
- **Database migrations and a coordinated cutover.** Generate and apply migrations before starting new processes: flow claim tokens, wait metadata and replay provenance; schedule definitions and ticks; durable pending job publication fields. A host with tenant data planes applies them to the control plane and to every tenant plane (`plumbus migrate apply --database <name>` or `applyDataPlaneMigrations`). Drain old flow-mutating API processes, workers and schedulers first; old and new workers must not process the same queues.
- **Beta behaviour that changed with the stabilization fixes.** Existing `flow_schedules` rows on every plane are skipped until `plumbus flow schedule sync --apply --expected-revision <revision>`. The command follows the worker's plane precedence (`dataPlaneResolver` before `schedulePlanes`); with tenant planes it reconciles the pool when a flow is scheduled on `spine`, plus each tenant the host lists (the `listTenantRefs` export with `dataPlaneResolver`, `schedulePlanes.listTenantRefs` otherwise); a tenant the worker only resolved for claimed work is not reconciled. A host that exports `dataPlaneResolver` without `listTenantRefs` must add the `listTenantRefs` export before the cutover when any scheduled flow is on `tenants` (the default when `schedule.plane` is unset); otherwise the command fails and the existing tenant schedules stay skipped. `plumbus flow dead-letter retry` creates a new replay execution; pass `--in-place` for the former reset of the same execution. Flows without a declared `backoff` retry exponentially (1 s base, 60 s cap) instead of every second, and budget exhaustion fails without retries. A runner that lost its lease no longer fails the execution. See the [core changelog](../packages/plumbus-core/CHANGELOG.md) entry for 0.9.0-beta.0.
- **Schedule reconciliation.** Startup seeds only the initial schedule set. Preview `plumbus flow schedule sync`, then apply with `plumbus flow schedule sync --apply --expected-revision <revision>`; inspect with `plumbus flow schedule list --json`.
- **Config file loading.** CLI startup and operational commands load `config/app.config.ts`, `.js` or `.mjs`; a file that used to be ignored now takes effect. Unknown keys fail validation.
- **Event delivery defaults.** An event without a matching local consumer is dead-lettered (`unrouted`) by default. List intentional no-consumer events in `workers.eventDelivery.ignoredEventTypes`, or set `unrouted: 'acknowledge'`.
- **Redis selection.** Once Redis is selected, a startup failure never falls back to memory; install `redis@^4.7.0` for Redis deployments. `cron-parser` is a core dependency now; do not install it for core.
- **Agent wiring refresh.** The 0.8.0-beta.N line shipped wiring v19; this release ships **v21** (`AGENTS.md` canonical, `CLAUDE.md` imports it, stabilization and deployment guidance linked). Run `plumbus init --patch --agent all`, then `plumbus doctor`.

### From the stable 0.8 family (npm `latest`)

The stabilization changes already apply to your app. Moving to the beta means the breaking changes this runbook documents for the beta line: apply every row of [Breaking changes in this family](#breaking-changes-in-this-family), review [Additive in this family](#additive-in-this-family) and its database notes, and select the beta for every installed Plumbus package (see [Installing the beta](#installing-the-beta)). Never mix stable 0.8-family packages with 0.9 beta packages. Run `plumbus init --patch --agent all` and `plumbus doctor` afterwards.

An app still on the 0.7 family follows the [stabilization guide](./upgrading-stabilization.md) first and then this section.

## Packages to publish

Prepared on **2026-10-14** for repository release **`v0.9.0-beta.0`**. The stable `latest` values below were verified against npm on that date. All 24 packages receive a new beta version: the 0.8 beta numbers are taken by the stable family, and every package has to leave both the stable 0.8-family ranges and the 0.8.0-beta.N ranges. Each package's beta contains everything in its stable `latest` version (the stable changes were merged from `main`) plus what the last column lists.

| Package | Stable (npm latest, 2026-10-14) | Beta | What the beta adds |
| --- | --- | --- | --- |
| `@plumbus/core` | 0.8.1 | 0.9.0-beta.0 (replaces 0.8.0-beta.10) | The whole 0.8.0-beta.N line: tenant data-plane routing with spine hints and schedule planes, compiled-flow reload, approval request cancellation, credential catalog (`./credentials`), request admission and idempotency (`./admission`), OpenAPI 3.1 from `plumbus generate`, AI provider admission and trace propagation, per-prompt and per-call request timeouts, strict structured-output and failed-call budget fixes, database connections that honour `ssl`, the four-tier action-risk vocabulary, explicit listen ports and `ctx.flows.terminate`; plus the tenant delay wake fix prepared as 0.8.0-beta.11 |
| `@plumbus/ui` | 0.9.0 | 0.10.0-beta.0 (replaces 0.9.0-beta.1) | Fetch clients, hooks and form hints only for `exposeAs: ['api']` capabilities; flow triggers only for descriptors with an explicit `startPath` |
| `@plumbus/mcp` | 0.7.0 | 0.8.0-beta.0 (replaces 0.7.0-beta.0) | `startHttpServer({ port })` and `plumbus mcp serve --http` require an explicit port |
| `@plumbus/voice` | 0.6.0 | 0.7.0-beta.0 (replaces 0.6.0-beta.1) | Server-only uploaded-file transcription runtime and cost recording (prepared as 0.6.0-beta.2, never published); see [file transcription](voice/file-transcription.md) |
| `@plumbus/ai-bedrock` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | Timeouts reported as timeout errors, per-call embedding timeout and cancellation |
| `@plumbus/api` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | OpenAPI 3.1 conversion shared with core |
| `@plumbus/auth` | 0.3.1 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | Beta peer range only (includes the auth 0.3.1 audit fix) |
| `@plumbus/auth-cognito` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.2) | Pool-provisioning concurrency guidance; auth peer `>=0.4.0-beta.0 <0.5.0` |
| `@plumbus/browser-extension` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | Scaffolding filtered to the served HTTP surface (explicit `startPath`) |
| `@plumbus/chat` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | Beta peer ranges only |
| `@plumbus/chat-ui` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | Beta peer ranges only |
| `@plumbus/knowledge-base` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | Beta peer range only |
| `@plumbus/voice-deepdub` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | Beta peer ranges only |
| `@plumbus/voice-elevenlabs` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | Beta peer ranges only |
| `@plumbus/voice-livekit` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.2) | Beta peer ranges only |
| `@plumbus/voice-minimax` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | Beta peer ranges only |
| `@plumbus/voice-openai` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | `gpt-realtime-whisper` priced at $0.017 per minute |
| `@plumbus/voice-soniox` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | Async file transcription (`SONIOX_FILE_TRANSCRIPTION_REGISTRATION`, prepared as 0.3.0-beta.2, never published) |
| `@plumbus/ai-decision` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | Beta peer range only; core depends on it as `~0.4.0-beta.0` |
| `@plumbus/ai-decision-typesafe` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | Shared contracts `~0.4.0-beta.0` |
| `@plumbus/ai-decision-laya` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.1) | Shared contracts `~0.4.0-beta.0` |
| `@plumbus/ai-decision-openai` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | Shared contracts `~0.4.0-beta.0` |
| `@plumbus/payments` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | Webhooks on the core runtime subpath with asynchronous tenant resolution (see [payment webhook data planes](payments/webhooks.md#tenant-data-planes)) |
| `@plumbus/payments-stripe` | 0.3.0 | 0.4.0-beta.0 (replaces 0.3.0-beta.0) | Beta peer ranges only; payments peer `>=0.4.0-beta.0 <0.5.0` |

All 24 packages move outside their previous caret range, including add-ons whose only change is the peer literal: every add-on peers on core, and a `0.8.x` peer would reject core 0.9. Canonical peer literals are in [peer dependencies](../packages/plumbus-core/instructions/peer-dependencies.md).

Core has a regular dependency on `@plumbus/ai-decision` (the shared decision contracts); in this release it is `~0.4.0-beta.0`, and the TypeSafe, Laya and OpenAI decision adapters depend on the same range. The publish workflow publishes that package before core; a core 0.9.0-beta.0 install cannot resolve until `@plumbus/ai-decision@0.4.0-beta.0` is on npm. The TypeSafe, Laya, and OpenAI adapters stay optional installs.

## Included in v0.9.0-beta.0

- **The 0.8.0-beta.N line**, unchanged in behaviour: everything published up to core 0.8.0-beta.10 (see [Included in v0.8.0-beta.10](#included-in-v080-beta10) and the core changelog), the breaking and additive changes below.
- **Prepared but never published on the 0.8 beta line, folded in here:** core 0.8.0-beta.11 corrects tenant delay hint scheduling without a schema or public API change (the next hint releases the previous lease and carries the persisted wake time; original flow authorization is preserved); voice 0.6.0-beta.2 and voice-soniox 0.3.0-beta.2 add [uploaded-file transcription](voice/file-transcription.md).
- **Stable changes merged from `main`:** core 0.8.0 (PLB-01 to PLB-10: event retry policy and `onEventDeadLetter`, bounded Redis startup, flow claim tokens and fenced wait signals, durable scheduler ticks, dead letters for unrouted events, Redis claim/reclaim/renew, persisted flow retry deadlines with flow dead letters and `plumbus flow dead-letter list|retry`, schedule definitions with core-owned cron parsing and `plumbus flow schedule sync|list`, durable job publication from flows, nested config overrides and `config/app.config.*` loading), core 0.8.1 (the delayed-wake promoter and scheduler poll catch and log failures), auth 0.3.1 (auth audit rows are saved and failed writes say why; the expiry sweep no longer rejects), Vitest 5.0.4 with the Node floor, agent wiring v21 with `AGENTS.md` canonical, and the core instruction `stabilization.md`.

## Prerelease peers

Semver ranges such as `0.9.x` do not match `0.9.0-beta.0`. During the beta every internal peer therefore uses a closed range, for example `">=0.9.0-beta.0 <0.10.0"` for core. That range accepts the betas and every later stable `0.9.N`, and still rejects the stable 0.8 family and the earlier `0.8.0-beta.N` prereleases. The other lines use the same shape: core's optional MCP peer is `">=0.8.0-beta.0 <0.9.0"`, voice providers peer on `">=0.7.0-beta.0 <0.8.0"`, and peers on the 0.4 add-ons (core's optional `@plumbus/api` and `@plumbus/ai-bedrock`; `@plumbus/knowledge-base`, `@plumbus/chat`, `@plumbus/auth` and `@plumbus/payments` from their dependants) use `">=0.4.0-beta.0 <0.5.0"`. The stable release replaces those literals with the plain `0.9.x` / `0.8.x` / `0.7.x` / `0.4.x` form in the same commit that removes the `-beta` suffixes.

## Installing the beta

Select the beta family explicitly for every installed Plumbus package in one dependency change:

```bash
npm install @plumbus/core@plumbus-next @plumbus/ui@plumbus-next @plumbus/voice@plumbus-next @plumbus/voice-livekit@plumbus-next
```

Do not mix beta packages with the stable 0.8 family (or the 0.7 family, or the earlier 0.8.0-beta.N prereleases), and do not use `--force` or `--legacy-peer-deps` to hide a mixed-family error. Existing lockfiles that pin `^0.8.x` or `0.8.0-beta.N` are unaffected until you select the beta. Use Node `^22.12.0 || ^24.0.0 || >=26.0.0`.

## Breaking changes in this family

These are the breaking changes of the beta line relative to the stable families. The stabilization changes (migrations, schedule sync, event delivery defaults, config file loading, Vitest 5 and the Node floor) are described in the [stabilization guide](./upgrading-stabilization.md); a stable 0.8 install has already applied them.

| Area | Who needs to act | Required action |
| --- | --- | --- |
| Action-risk vocabulary | Capabilities declaring `actionRisk: 'read-only'` | Use `analytical`. `read-only` is a retired value and `defineCapability` rejects it. `prohibited` is normative: the approval gate refuses prohibited capabilities outright and they cannot be exposed as MCP tools or API routes. |
| Listen ports | Apps relying on default ports 3000/3001 | `plumbus e2e --port`, `plumbus worker --health-port`, `plumbus mcp serve --http --port`, `createServer({ port })`, and `startHttpServer({ port })` require an explicit port (or the matching `PLUMBUS_*_PORT` variable). |
| `plumbus ui generate` | Projects without a detected frontend, and frontends that called a generated `start{Flow}` function | Pass `--out-dir`; `.plumbus/generated/ui` is no longer a silent default. Fetch clients, hooks, and form hints are emitted only for `exposeAs: ['api']` capabilities. Since ui 0.9.0-beta.1 a `start{Flow}` trigger is emitted only for a flow descriptor with an explicit `startPath`; discovered flows no longer get a phantom `/api/{domain}/{flow}/start` client. Start flows through an API-exposed capability (`ctx.flows.start`) and call its ordinary client. The browser-extension scaffold (0.3.0-beta.1) applies the same filter to its background registry and popup. |
| `plumbus generate` | Tooling that parsed the generated OpenAPI 3.0 document | `.plumbus/generated/openapi.json` is OpenAPI 3.1.0 with JSON Schema 2020-12 nullables. Leftover `.plumbus/generated/clients/` trees are deleted on the next run. |
| Flow compensations | Executions whose stored auth snapshot is missing or invalid | Compensations run as the verified initiating identity, never as the worker. An invalid snapshot records a failed `compensate` history entry and a `flow.compensation_skipped` audit event for operator review. |
| 403 error bodies | Clients that read a refusal reason from a 403 | The message is always `Access denied` and every metadata key is dropped except `reason`. Put the operational code the client may act on in `metadata.reason` at the throw site; nothing else about a 403 reaches the caller. |
| Audit writer refusals | Custom `AuditWriter` implementations | A writer that throws a `PlumbusError` is refusing the record: `AuditService.record` rethrows it as is, with no retry and no `Audit persistence failed` wrapper. Any other error is still retried three times and then wrapped. |
| Reasoning configuration | Apps that used the widened legacy `reasoningEffort` values | Use the provider-neutral `reasoning` config from the 0.7 family. `REASONING_EFFORTS` / `ReasoningEffortOption` remain the vocabulary of `ProviderModel.reasoningEfforts` metadata. |
| Access before input parsing | Clients and tests that expected `400` for malformed input from a caller the capability's static policy rejects | Since core 0.8.0-beta.5 roles, scopes, tenant and principal checks run before the Zod input parse, for capability execution and HTTP queued jobs alike: a statically denied caller gets `403` (audit outcome `denied`, no schema issues) whether or not the input is well-formed. The input-aware `authorize(ctx, input)` hook still runs after parsing and still sees the transformed input. See [security model](security/security-model.md#authorization-and-validation-ordering). |
| Database TLS | Production hosts whose Postgres has no TLS, or a certificate Node does not trust | Since core 0.8.0-beta.8 the server and worker connection, `plumbus seed`, `plumbus run` and `migrate`'s maintenance connections actually use the configured `ssl` (production defaults to it); before, they connected in plain text whatever the configuration said. A Postgres without TLS: set `DATABASE_SSL=false` (production now honours it, with a warning). A private CA (Amazon RDS, self-hosted): add it with `NODE_EXTRA_CA_CERTS`. |

### Additive in this family

| Area | Who it is for | What changed |
| --- | --- | --- |
| Host data-plane resolver | Hosts that route tenant data themselves and want flow state on the tenant plane | `app/server.ts` may export `dataPlaneResolver`, `listTenantRefs`, `untenantedDataPlane`, `requestDataPlane`, `workerDataPlane` and `resolveTenantRef`; `plumbus dev` / `start` / `worker` pass them to `createServer` and the worker pool. Request-side flow engines then carry `spineDispatch`, so a flow a request starts is written to the tenant plane with an opaque hint on the control plane. `FlowSpineDispatchConfig.untenanted: 'control-plane'` lets control-plane flows (no tenant) stay classic spine rows claimed beside the tenant hints; `requestDataPlane: 'control-plane'` keeps request repositories on the boot connection, and `workerDataPlane: 'control-plane'` does the same for claimed units (`WorkerPoolConfig.unitDataPlane`). Under `'resolved'`, a `tenantScoped: false` capability now reads the control plane even for a tenant-bound request. `retryDeadLetteredFlow` takes an optional `placement` (`{ spineDb, coreSchema? }`) that reopens a tenant-placed execution and publishes a fresh spine hint (`republished` on the result); `engine.cancel` and the runner's failure finaliser close the durable state of a tenant-placed execution, and a claim drops the hint of a terminal row instead of reviving it. Follow-up hints between drained steps are published under the running worker's lease; acknowledged hints close their outbox rows; the outbox pump publishes only never-published rows (it used to re-ready every unacknowledged row on each poll, clearing live leases); a hint whose plane fails to resolve is dead-lettered after `maxClaimAttempts` claims; the worker's engine now carries `untenanted` on its spine dispatch, so control-plane rows are claimed beside the hints. Since core 0.9.0-beta.0 an ordinary `delay` step of a tenant-placed flow publishes its next hint with the persisted wake time and releases the previous lease, so the step is claimed when due rather than after the lease expires. Under resolved worker planes (a resolver with `workerDataPlane`/`unitDataPlane` left at `resolved`), a flow step on a tenant-plane unit cannot enqueue jobs yet: `ctx.jobs.enqueue()` throws `Job queue not configured on this execution context` and the step fails. Flow steps on the control plane (no resolver, `workerDataPlane: 'control-plane'`, untenanted control-plane work) keep the 0.8 flow job wiring. See [Tenant Data Planes](sdk-reference/tenant-data-planes.md). |
| AI provider admission and trace propagation | Hosts that meter or trace outbound model calls | `app/server.ts` may export `aiProviderConcurrency` (immediate per-scope ceiling, default scope provider + tenant + `costContext.serviceArea`; saturation throws `ai-provider-concurrency-exhausted` with `retryAfterSeconds: 1`, never queues), `resolveAIProviderHeaders` (trusted W3C `traceparent` / `tracestate` for every provider attempt, reaching the adapter as `ProviderRequest.transportHeaders`; credential and content-type headers are refused) and `onAIProviderSpan` (best-effort client-span export). `createAIService` takes the same as `providerConcurrency` / `resolveProviderHeaders` / `onProviderSpan`; `withContext` accepts `correlationId` and flow workers bind the persisted flow correlation id. See [AI integration](ai/ai-integration.md#provider-admission-and-trace-propagation). |
| `ctx.flows.terminate` | Operator recovery capabilities | `FlowService` exposes the engine's `terminate(executionId)`: abort and close as `cancelled` without compensations, beside `cancel`, which runs every declared compensation. See [Flows](core-concepts/flows.md#cancellation). |
| Approval request cancellation | Hosts with human-approval workflows | `ApprovalService.cancel({ requestId, auth, reason })` withdraws a still-pending request after human-actor and host-authorization revalidation, records cancellation evidence, and atomically cancels linked open/claimed human tasks without writing an approval decision. Tenant durable migration `0002_approval_cancellation.sql` adds the evidence columns. See [Approvals](core-concepts/approvals.md). |
| Typed decisions and classification | Apps that call TypeSafe/Jev or self-hosted Laya decision providers | Since core 0.8.0-beta.6, `ctx.ai.decide()` runs a decision adapter over the shared `@plumbus/ai-decision` contract with security checks, budgets, cancellation and per-call cost records through `onAICostRecorded`, and `ctx.ai.classify()` takes optional `provider` / `model` to route labels to a text provider or a decision adapter (labels at or above `threshold`, default 0.5). Register providers with `export const decisions = { providers, defaultProvider }` in `app/server.ts`; named definitions live under `app/decisions/`. Install the matching adapter from the version table explicitly. Agent wiring v17 first linked the classification recipe; the 0.8.0-beta.10 release provided v19 and this release provides v21. Refresh with `plumbus init --patch --agent all`. See [Decision providers](ai/decision-providers.md). |
| Server-attested Cognito sign-in | Apps that keep their own passwordless sign-in (magic links, passkeys) and want Cognito as the user directory and token issuer | Since auth-cognito 0.3.0-beta.1, `@plumbus/auth-cognito/server` creates attested user pools and their users and signs a person in from the server through custom auth answered with an HMAC attestation; `./triggers` is the matching dependency-free Lambda for the Define/Create/Verify triggers, and `./testing` provides `startFakeCognito()`. These subpaths bring the AWS SDK and `jose`; the root `cognito()` export is unchanged. See [Server-attested sign-in](auth/cognito.md#server-attested-sign-in-passwordless-apps). |
| Events audit vocabulary | Every host | The dispatcher and the event worker record their audit with the outcomes `createAuditService` accepts (`success` / `failure` / `denied`); `event.dispatch.attempt`, `event.consumer.attempt` and `event.consumer.skipped` carry no outcome, `event.dispatch.failed` and `event.consumer.dead_lettered` are `failure` (the former adds `disposition: retry \| dead_lettered`). Before, they wrote `pending` / `retry` / `dead_lettered` / `skipped`, which the audit service refused — so with the real audit service every dispatch attempt threw, and one plane's rejected poll escaped the timer and ended the worker process. The outbox poll now contains a failing plane and keeps polling the others. Since core 0.8.0-beta.7 these audit entries are best-effort (a failed audit write is logged to the optional `logger` and never blocks a publish, a consumer handler or a dead-letter write), and each poll returns `event_outbox` rows stuck in `processing` for longer than `claimTimeoutMs` (default 5 minutes) to `pending`. |
| Uploaded-file transcription | Apps that transcribe recorded audio or video files on the server | Since voice 0.7.0-beta.0, `@plumbus/voice` provides bounded server-only file transcription contracts, explicit provider registration and actual token/media cost recording; `@plumbus/voice-soniox` 0.4.0-beta.0 registers the Soniox async adapter with `SONIOX_FILE_TRANSCRIPTION_REGISTRATION`. The app's capabilities and flows keep durable state, rights, reservations and recovery. See [File transcription](voice/file-transcription.md). |

Database changes: the stabilization migrations are **required** for every 0.9 beta install, whether you come from the 0.8 beta or the 0.7 family — flow claim tokens, wait metadata and replay provenance, schedule definitions and ticks, and durable pending job publication fields (see the [stabilization guide](./upgrading-stabilization.md#upgrade-and-rollback)). The beta-line schema additions are opt-in: a host enabling spine dispatch needs the framework's `opaque_dispatch` table on its control plane (`migrations/spine/0000_opaque_dispatch.sql`) and the `core_plumbus` durable tables on each tenant plane (the generator already emits them). Hosts that store approval requests and want `ApprovalService.cancel` need `migrations/durable-tenant/0002_approval_cancellation.sql` on each tenant plane. The tenant delay fix and file transcription add no framework schema.

## Publication

The three identifiers serve different purposes:

| Identifier | Meaning for this release |
| --- | --- |
| Git tag `v0.9.0-beta.0` | The repository snapshot for this release; pushing it starts `.github/workflows/publish.yml`. Earlier `v0.8.0-beta.*` tags and the stable `v0.8.0` / `v0.8.1` tags from `main` remain unchanged. |
| Package version | Each package's immutable `package.json` version, as listed above. Add-ons do not all become `0.9.0-beta.0`. |
| npm dist-tag `plumbus-next` | The movable install alias for each package's beta version. `latest` stays on the stable 0.8 family. |

Run the local checks on Node `^22.12.0 || ^24.0.0 || >=26.0.0` (the publish workflow uses Node 24). Before running them, provide a reachable, isolated PostgreSQL test
database with password authentication. Set `PLUMBUS_TEST_PG_HOST`,
`PLUMBUS_TEST_PG_PORT` (required), `PLUMBUS_TEST_PG_DATABASE`,
`PLUMBUS_TEST_PG_USER`, and `PLUMBUS_TEST_PG_PASSWORD` for that database; do not
point tests at application data. The stabilization integration fixtures also start
their own `redis-server` and PostgreSQL 16 processes: install both, and set
`PLUMBUS_TEST_POSTGRES_BIN` when the PostgreSQL binaries are not in
`/usr/lib/postgresql/16/bin`. See the [testing guide](testing/testing-guide.md).
Prepare and validate from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm build
pnpm typecheck
pnpm test
```

Also complete the packed npm consumer checks in the
[security release runbook](./upgrading-security-release.md#release-preparation-checks)
using **all 24 packages** in this family; the historical runbook's 18-package count
is not the package set for this release.
The generic `scripts/bump-version.sh` only handles core, UI and voice and accepts
stable `patch`/`minor`/`major` bumps; it does not prepare this beta release.

After the checks pass, review `git status` and `git diff` on `plumbus-next` and
confirm that only the intended changes and release documentation are present. The
operator sequence for this release:

```bash
git add -A
git commit -m "chore(release): prepare v0.9.0-beta.0"
git push origin plumbus-next
git tag -a v0.9.0-beta.0 -m "Plumbus core 0.9 beta 0"
git push origin refs/tags/v0.9.0-beta.0
```

Agents need explicit per-command approval for these Git writes under `AGENTS.md`.
Never move or reuse an existing release tag. Push the branch before the tag: the
workflow derives the npm dist-tag from a remote branch containing the tagged
commit. A commit contained in `main` publishes under `latest`; a commit contained
only in `plumbus-next` publishes under `plumbus-next`. A tagged commit on no remote
branch fails instead of choosing an alias. Keep this beta release off `main` until
promotion is intended.

The workflow installs with the frozen lockfile and runs lint, format check, build,
typecheck and tests before publication, with PostgreSQL, PostgreSQL 16 binaries
and Redis available for database and queue tests. It publishes all 24 packages in
dependency order, including shared decision contracts before core and adapters and
payments before its Stripe provider. For each package, it checks npm for that exact
version: an existing version is skipped; a missing version is published under the
resolved dist-tag. Therefore publishing again cannot replace an existing version's
contents. A skipped package's dist-tags are not changed by the workflow.

Watch the **Publish to npm** workflow and wait for its successful completion, then
verify the registry:

```bash
gh run list --workflow publish.yml --limit 5
npm view @plumbus/core@plumbus-next version
npm view @plumbus/ui@plumbus-next version
npm view @plumbus/mcp@plumbus-next version
npm view @plumbus/voice@plumbus-next version
npm view @plumbus/ai-decision@plumbus-next version
npm view @plumbus/ai-decision-typesafe@plumbus-next version
npm view @plumbus/ai-decision-laya@plumbus-next version
npm view @plumbus/ai-bedrock@plumbus-next version
npm view @plumbus/auth@plumbus-next version
npm view @plumbus/auth-cognito@plumbus-next version
npm view @plumbus/voice-livekit@plumbus-next version
npm view @plumbus/voice-soniox@plumbus-next version
npm view @plumbus/ai-decision-openai@plumbus-next version
npm view @plumbus/payments@plumbus-next version
npm view @plumbus/payments-stripe@plumbus-next version
npm view @plumbus/core dist-tags --json
```

Expect the package versions in the table, with core `plumbus-next` at
`0.9.0-beta.0` and core `latest` still at `0.8.1` for this release. Install the beta
explicitly in consumers; include every Plumbus package the app already uses and
only the optional providers it needs. For example, a core app using OpenAI
Decisions installs:

```bash
pnpm add @plumbus/core@plumbus-next @plumbus/ai-decision-openai@plumbus-next
pnpm exec plumbus init --patch --agent all
pnpm exec plumbus doctor
```

Promoting the beta to `latest` is a separate release decision after the entire
family and consumer staging checks pass.

## History of the 0.8.0-beta line

The beta line was published as core `0.8.0-beta.0` through `0.8.0-beta.10` (UI
`0.9.0-beta.N`, MCP `0.7.0-beta.N`, voice `0.6.0-beta.N`, add-ons `0.3.0-beta.N`)
under `plumbus-next`, with peers such as `">=0.8.0-beta.0 <0.9.0"`. Those versions
stay on npm; they are superseded by the 0.9 beta family and must not be mixed with
it. The sections below are the release record of that line; do not run their
commands again.

### Packages in v0.8.0-beta.10

Prepared on **2026-10-12** for repository release `v0.8.0-beta.10` and published
by the retry under repository tag `v0.8.0-beta.11`. The `latest` values were the
0.7 family on that date.

| Package | Previous (latest) | Beta |
| --- | --- | --- |
| `@plumbus/core` | 0.7.9 | 0.8.0-beta.10 (beta.5 + core 0.7.2–0.7.6 from `main`: typed decisions through `ctx.ai.decide()`, `ctx.ai.classify()` provider/model routing, agent wiring v17, structured answers with native tools, Claude Opus 5.5 and GPT-6 pricing, GPT-6 request compatibility, best-effort event pipeline audit and stale outbox claim release; generated OpenAPI documents a declared `api.method`; beta.8: database connections honour `ssl`; beta.9: GPT-6 reasoning levels, 2026-10-01 price sync with `claude-sonnet-5-5` and the 272K long-context premium on every OpenAI model priced that way; beta.10: the main integration and AI timeout, strict-output and failed-call budget fixes below) |
| `@plumbus/ui` | 0.8.1 | 0.9.0-beta.1 (beta.0 + flow triggers only for descriptors with an explicit `startPath`) |
| `@plumbus/mcp` | 0.6.1 | 0.7.0-beta.0 |
| `@plumbus/voice` | 0.5.2 | 0.6.0-beta.1 (beta.0 + voice 0.5.2: `resolveSttContext`, `tts.responseMode: 'reply'`, STT error recovery, `transcript.maxChars`); 0.6.0-beta.2 (file transcription) was staged locally and is published as 0.7.0-beta.0 |
| `@plumbus/ai-bedrock` | 0.2.2 | 0.3.0-beta.1 (prompt caching, timeout errors and embedding cancellation) |
| `@plumbus/api` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/auth` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/auth-cognito` | 0.2.2 | 0.3.0-beta.2 (beta.1: server-attested sign-in through `./server`, `./triggers`, `./testing`; beta.2: pool-provisioning concurrency guidance) |
| `@plumbus/browser-extension` | 0.2.1 | 0.3.0-beta.1 (beta.0 + scaffolding filtered to the served HTTP surface) |
| `@plumbus/chat` | 0.2.2 | 0.3.0-beta.1 (beta.0 + chat 0.2.2: structured custom-agent output through `onAgentOutput`) |
| `@plumbus/chat-ui` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/knowledge-base` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-deepdub` | 0.2.2 | 0.3.0-beta.1 (beta.0 + default model `dd-etts-3.3`) |
| `@plumbus/voice-elevenlabs` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-livekit` | 0.2.3 | 0.3.0-beta.2 (beta.1: 20 ms PCM framing and text streams for events above 15 KiB; beta.2: compatible LiveKit native dependencies) |
| `@plumbus/voice-minimax` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-openai` | 0.2.1 | 0.3.0-beta.1 (beta.0 + `gpt-realtime-whisper` at $0.017 per minute) |
| `@plumbus/voice-soniox` | 0.2.2 | 0.3.0-beta.1 (beta.0 + per-session recognition context, STT error callback); 0.3.0-beta.2 (async file transcription) was staged locally and is published as 0.4.0-beta.0 |
| `@plumbus/ai-decision` | 0.2.3 | 0.3.0-beta.1 (beta.0 joined with core 0.8.0-beta.6; beta.1 adds endpoint paths and rounding support for OpenAI Decisions) |
| `@plumbus/ai-decision-typesafe` | 0.2.3 | 0.3.0-beta.1 |
| `@plumbus/ai-decision-laya` | 0.2.3 | 0.3.0-beta.1 |
| `@plumbus/ai-decision-openai` | 0.2.0 | 0.3.0-beta.0 (OpenAI Decisions API provider) |
| `@plumbus/payments` | 0.2.2 | 0.3.0-beta.0 (payment capabilities, billing, entities, events and webhooks) |
| `@plumbus/payments-stripe` | 0.2.2 | 0.3.0-beta.0 (Stripe provider; payments peer `>=0.3.0-beta.0 <0.4.0`) |

Since 0.8.0-beta.6 core has had a regular dependency on `@plumbus/ai-decision` (`~0.3.0-beta.0`, the shared decision contracts); core 0.8.0-beta.10 and the decision adapters of that release depend on `~0.3.0-beta.1`, which includes OpenAI rounding support.

### Included in v0.8.0-beta.10

This release published the later main-line fixes and features below together with
the branch's AI fixes, using the package versions above. The stable release numbers
in changelogs record where main-line changes originated; this release kept the
0.8-beta peer ranges.

- Core includes the stable 0.7.7–0.7.9 additions: `field.bigint()`, exported collection
  discovery, payments CLI commands, `authenticationRuntime` loading from
  `app/server.ts`, agent wiring v19, OpenAI Decisions integration, prompt caching,
  per-attempt validation cost accounting, and updated model compatibility and pricing.
  Later main fixes include capability error hooks for flow/job/event execution and
  draining the e2e dev server's output. Existing beta security, tenant data planes,
  credential hooks, strict-output handling, request timeouts and failed-call budgets
  are retained.
- `@plumbus/ai-decision-openai`, `@plumbus/payments`, and `@plumbus/payments-stripe`
  join as `0.3.0-beta.0`, with the same `plumbus-next` publication tag as the rest of
  the family. Install them explicitly only when used; never mix their stable
  versions with the beta family. The shared decision package includes endpoint-path and
  rounding support for OpenAI.
- Payment webhooks resolve tenant dependencies asynchronously. Seller-account
  routing and platform-object fallback lookups still require rows visible on the
  control plane; they do not scan tenant databases. Hosts must separately wire
  outbox dispatch and payment consumers for each database holding payment data;
  the default consumers stay on their configured database. See
  [payment webhook data planes](payments/webhooks.md#tenant-data-planes) before
  placing payment entities on separate planes.
- Bedrock includes Converse prompt caching; Cognito includes hosted-directory
  helpers and the guidance to provision a pool from one place; LiveKit retains its
  20 ms PCM framing and stream fixes while pinning compatible native dependencies
  (`@livekit/agents` 1.9.0 and `@livekit/rtc-node` ^0.13.34).

Refresh consumer-agent wiring with `plumbus init --patch --agent all`. See
[decision providers](ai/decision-providers.md), [payments](payments/README.md),
[AI integration](ai/ai-integration.md), and the
[capability error hook](sdk-reference/configuration.md#oncapabilityerror-hook).

### Original beta.10 attempt (historical)

The following sequence created the original release tag. It is retained as history;
do not run it again. [Retry after beta.10](#retry-after-beta10) records the
corrected release.

```bash
git add -A
git commit -m "chore(release): prepare v0.8.0-beta.10"
git push origin plumbus-next
git tag -a v0.8.0-beta.10 -m "Plumbus core 0.8 beta 10"
git push origin refs/tags/v0.8.0-beta.10
```

### Retry after beta.10

The [original publish run](https://github.com/plumbus-framework/plumbus/actions/runs/38216103657)
used **Node 24.21.0** and failed two fetch-dispatcher tests after lint, format,
build and typecheck passed. All 24 publication steps were skipped, and npm checks
confirmed that none of the ten planned new package versions was published. Those
package versions remained valid for the retry, including core **`0.8.0-beta.10`**.

Rerunning the old tag's workflow tests its original commit, not the corrected
branch. Never move or recreate `v0.8.0-beta.10`. After the fixes passed the checks
on Node 24, the operator sequence used a fresh repository tag:

```bash
git add -A
git commit -m "fix(test): support Node 24 fetch dispatchers"
git push origin plumbus-next
git tag -a v0.8.0-beta.11 -m "Retry core 0.8 beta release"
git push origin refs/tags/v0.8.0-beta.11
```

The repository tag advanced to identify the corrected snapshot; the package
versions in the table and the `plumbus-next` npm dist-tag stayed as planned
(core `plumbus-next` at `0.8.0-beta.10`).

### Prepared as 0.8.0-beta.11 (never published)

Core `0.8.0-beta.11`, voice `0.6.0-beta.2` and voice-soniox `0.3.0-beta.2` were
staged locally after the retry and never reached npm. Core `0.8.0-beta.11` corrects
tenant delay hint scheduling without a schema or public API change: the next hint
releases the previous lease and carries the persisted wake time; original flow
authorization is preserved. The voice packages add uploaded-file transcription.
These changes ship in core `0.9.0-beta.0`, voice `0.7.0-beta.0` and voice-soniox
`0.4.0-beta.0`.
