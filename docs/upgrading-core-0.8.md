# Upgrading to core 0.8 (beta)

Core 0.8 is the next coordinated release family after the 0.7 security release. It carries breaking changes, so every package moves to a new minor line and the family is first published as **`-beta.N` prereleases under a branch-named npm dist-tag** (`plumbus-next` while it is tagged from that branch). `latest` keeps pointing at the 0.7 family until the beta is promoted.

## Packages to publish

Prepared on **2026-10-12** for repository release **`v0.8.0-beta.10`**. The stable
`latest` values below were verified against npm on that date. Seven existing
packages receive new beta versions; three packages publish their first beta.
Other package versions remain unchanged.

| Package | Previous (latest) | Beta |
| --- | --- | --- |
| `@plumbus/core` | 0.7.9 | 0.8.0-beta.10 (beta.5 + core 0.7.2–0.7.6 from `main`: typed decisions through `ctx.ai.decide()`, `ctx.ai.classify()` provider/model routing, agent wiring v17, structured answers with native tools, Claude Opus 5.5 and GPT-6 pricing, GPT-6 request compatibility, best-effort event pipeline audit and stale outbox claim release; generated OpenAPI documents a declared `api.method`; beta.8: database connections honour `ssl`; beta.9: GPT-6 reasoning levels, 2026-10-01 price sync with `claude-sonnet-5-5` and the 272K long-context premium on every OpenAI model priced that way; beta.10: the main integration and AI timeout, strict-output and failed-call budget fixes below) |
| `@plumbus/ui` | 0.8.1 | 0.9.0-beta.1 (beta.0 + flow triggers only for descriptors with an explicit `startPath`) |
| `@plumbus/mcp` | 0.6.1 | 0.7.0-beta.0 |
| `@plumbus/voice` | 0.5.2 | 0.6.0-beta.1 (beta.0 + voice 0.5.2: `resolveSttContext`, `tts.responseMode: 'reply'`, STT error recovery, `transcript.maxChars`) |
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
| `@plumbus/voice-soniox` | 0.2.2 | 0.3.0-beta.1 (beta.0 + per-session recognition context, STT error callback) |
| `@plumbus/ai-decision` | 0.2.3 | 0.3.0-beta.1 (beta.0 joined with core 0.8.0-beta.6; beta.1 adds endpoint paths and rounding support for OpenAI Decisions) |
| `@plumbus/ai-decision-typesafe` | 0.2.3 | 0.3.0-beta.1 |
| `@plumbus/ai-decision-laya` | 0.2.3 | 0.3.0-beta.1 |
| `@plumbus/ai-decision-openai` | 0.2.0 | 0.3.0-beta.0 (OpenAI Decisions API provider) |
| `@plumbus/payments` | 0.2.2 | 0.3.0-beta.0 (payment capabilities, billing, entities, events and webhooks) |
| `@plumbus/payments-stripe` | 0.2.2 | 0.3.0-beta.0 (Stripe provider; payments peer `>=0.3.0-beta.0 <0.4.0`) |

All 24 packages move outside their previous caret range, including add-ons whose only change is the peer literal: every add-on peers on core, and a `0.7.x` peer would reject core 0.8. Canonical peer literals are in [peer dependencies](../packages/plumbus-core/instructions/peer-dependencies.md).

Since 0.8.0-beta.6 core has a regular dependency on `@plumbus/ai-decision` (`~0.3.0-beta.0`, the shared decision contracts). The publish workflow publishes that package before core; a core 0.8.0-beta.6 install cannot resolve until `@plumbus/ai-decision@0.3.0-beta.0` is on npm. Core 0.8.0-beta.10 and the current decision adapters now depend on `~0.3.0-beta.1`, which includes OpenAI rounding support. The TypeSafe, Laya, and OpenAI adapters stay optional installs.

## Included in v0.8.0-beta.10

This release publishes the later main-line fixes and features below together with
the branch's AI fixes, using the package versions above. The stable release numbers
in changelogs record where main-line changes originated; this release keeps the
0.8-family peer ranges.

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
  versions with core 0.8. The shared decision package includes endpoint-path and
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

## Prerelease peers

Semver ranges such as `0.8.x` do not match `0.8.0-beta.0`. During the beta every internal peer therefore uses a closed range, for example `">=0.8.0-beta.0 <0.9.0"` for core. That range accepts the betas and every later stable `0.8.N`, and still rejects 0.7.x. The stable release replaces those literals with the plain `0.8.x` form in the same commit that removes the `-beta` suffixes.

## Installing the beta

Select the beta family explicitly for every installed Plumbus package in one dependency change:

```bash
npm install @plumbus/core@plumbus-next @plumbus/ui@plumbus-next @plumbus/voice@plumbus-next @plumbus/voice-livekit@plumbus-next
```

Do not mix beta packages with the 0.7 family, and do not use `--force` or `--legacy-peer-deps` to hide a mixed-family error. Existing lockfiles that pin `^0.7.x` are unaffected.

## Breaking changes in this family

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
| Host data-plane resolver | Hosts that route tenant data themselves and want flow state on the tenant plane | `app/server.ts` may export `dataPlaneResolver`, `listTenantRefs`, `untenantedDataPlane`, `requestDataPlane`, `workerDataPlane` and `resolveTenantRef`; `plumbus dev` / `start` / `worker` pass them to `createServer` and the worker pool. Request-side flow engines then carry `spineDispatch`, so a flow a request starts is written to the tenant plane with an opaque hint on the control plane. `FlowSpineDispatchConfig.untenanted: 'control-plane'` lets control-plane flows (no tenant) stay classic spine rows claimed beside the tenant hints; `requestDataPlane: 'control-plane'` keeps request repositories on the boot connection, and `workerDataPlane: 'control-plane'` does the same for claimed units (`WorkerPoolConfig.unitDataPlane`). Under `'resolved'`, a `tenantScoped: false` capability now reads the control plane even for a tenant-bound request. `retryDeadLetteredFlow` takes an optional `placement` (`{ spineDb, coreSchema? }`) that reopens a tenant-placed execution and publishes a fresh spine hint (`republished` on the result); `engine.cancel` and the runner's failure finaliser close the durable state of a tenant-placed execution, and a claim drops the hint of a terminal row instead of reviving it. Follow-up hints between drained steps are published under the running worker's lease; acknowledged hints close their outbox rows; the outbox pump publishes only never-published rows (it used to re-ready every unacknowledged row on each poll, clearing live leases); a hint whose plane fails to resolve is dead-lettered after `maxClaimAttempts` claims; the worker's engine now carries `untenanted` on its spine dispatch, so control-plane rows are claimed beside the hints. See [Tenant Data Planes](sdk-reference/tenant-data-planes.md). |
| AI provider admission and trace propagation | Hosts that meter or trace outbound model calls | `app/server.ts` may export `aiProviderConcurrency` (immediate per-scope ceiling, default scope provider + tenant + `costContext.serviceArea`; saturation throws `ai-provider-concurrency-exhausted` with `retryAfterSeconds: 1`, never queues), `resolveAIProviderHeaders` (trusted W3C `traceparent` / `tracestate` for every provider attempt, reaching the adapter as `ProviderRequest.transportHeaders`; credential and content-type headers are refused) and `onAIProviderSpan` (best-effort client-span export). `createAIService` takes the same as `providerConcurrency` / `resolveProviderHeaders` / `onProviderSpan`; `withContext` accepts `correlationId` and flow workers bind the persisted flow correlation id. See [AI integration](ai/ai-integration.md#provider-admission-and-trace-propagation). |
| `ctx.flows.terminate` | Operator recovery capabilities | `FlowService` exposes the engine's `terminate(executionId)`: abort and close as `cancelled` without compensations, beside `cancel`, which runs every declared compensation. See [Flows](core-concepts/flows.md#cancellation). |
| Approval request cancellation | Hosts with human-approval workflows | `ApprovalService.cancel({ requestId, auth, reason })` withdraws a still-pending request after human-actor and host-authorization revalidation, records cancellation evidence, and atomically cancels linked open/claimed human tasks without writing an approval decision. Tenant durable migration `0002_approval_cancellation.sql` adds the evidence columns. See [Approvals](core-concepts/approvals.md). |
| Typed decisions and classification | Apps that call TypeSafe/Jev or self-hosted Laya decision providers | Since core 0.8.0-beta.6, `ctx.ai.decide()` runs a decision adapter over the shared `@plumbus/ai-decision` contract with security checks, budgets, cancellation and per-call cost records through `onAICostRecorded`, and `ctx.ai.classify()` takes optional `provider` / `model` to route labels to a text provider or a decision adapter (labels at or above `threshold`, default 0.5). Register providers with `export const decisions = { providers, defaultProvider }` in `app/server.ts`; named definitions live under `app/decisions/`. Install the matching adapter from the version table explicitly. Agent wiring v17 first linked the classification recipe; this release provides v19. Refresh with `plumbus init --patch --agent all`. See [Decision providers](ai/decision-providers.md). |
| Server-attested Cognito sign-in | Apps that keep their own passwordless sign-in (magic links, passkeys) and want Cognito as the user directory and token issuer | Since auth-cognito 0.3.0-beta.1, `@plumbus/auth-cognito/server` creates attested user pools and their users and signs a person in from the server through custom auth answered with an HMAC attestation; `./triggers` is the matching dependency-free Lambda for the Define/Create/Verify triggers, and `./testing` provides `startFakeCognito()`. These subpaths bring the AWS SDK and `jose`; the root `cognito()` export is unchanged. See [Server-attested sign-in](auth/cognito.md#server-attested-sign-in-passwordless-apps). |
| Events audit vocabulary | Every host | The dispatcher and the event worker record their audit with the outcomes `createAuditService` accepts (`success` / `failure` / `denied`); `event.dispatch.attempt`, `event.consumer.attempt` and `event.consumer.skipped` carry no outcome, `event.dispatch.failed` and `event.consumer.dead_lettered` are `failure` (the former adds `disposition: retry \| dead_lettered`). Before, they wrote `pending` / `retry` / `dead_lettered` / `skipped`, which the audit service refused — so with the real audit service every dispatch attempt threw, and one plane's rejected poll escaped the timer and ended the worker process. The outbox poll now contains a failing plane and keeps polling the others. Since core 0.8.0-beta.7 these audit entries are best-effort (a failed audit write is logged to the optional `logger` and never blocks a publish, a consumer handler or a dead-letter write), and each poll returns `event_outbox` rows stuck in `processing` for longer than `claimTimeoutMs` (default 5 minutes) to `pending`. |

No database schema changes are introduced by this family beyond the tenant data-plane helpers and the approval-cancellation evidence columns, which are opt-in — a host enabling spine dispatch needs the framework's `opaque_dispatch` table on its control plane (`migrations/spine/0000_opaque_dispatch.sql`) and the `core_plumbus` durable tables on each tenant plane (the generator already emits them). Hosts that store approval requests and want `ApprovalService.cancel` need `migrations/durable-tenant/0002_approval_cancellation.sql` on each tenant plane.

## Publication

The three identifiers serve different purposes:

| Identifier | Meaning for this release |
| --- | --- |
| Git tag `v0.8.0-beta.10` | One repository snapshot; pushing it starts `.github/workflows/publish.yml`. |
| Package version | Each package's immutable `package.json` version, as listed above. Add-ons do not all become `0.8.0-beta.10`. |
| npm dist-tag `plumbus-next` | The movable install alias for each package's beta version. `latest` stays on the stable 0.7 family. |

Before running the local checks, provide a reachable, isolated PostgreSQL test
database with password authentication. Set `PLUMBUS_TEST_PG_HOST`,
`PLUMBUS_TEST_PG_PORT` (required), `PLUMBUS_TEST_PG_DATABASE`,
`PLUMBUS_TEST_PG_USER`, and `PLUMBUS_TEST_PG_PASSWORD` for that database; do not
point tests at application data. See the [testing guide](testing/testing-guide.md).
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

Review `git status` and `git diff` on `plumbus-next`. Once the working tree contains
only the intended, validated release changes, the operator release sequence is:

```bash
git add -A
git commit -m "chore(release): prepare v0.8.0-beta.10"
git push origin plumbus-next
git tag -a v0.8.0-beta.10 -m "Plumbus core 0.8 beta 10"
git push origin refs/tags/v0.8.0-beta.10
```

Agents need explicit per-command approval for these Git writes under `AGENTS.md`.
Never move or reuse an existing release tag. Push the branch before the tag: the
workflow derives the npm dist-tag from a remote branch containing the tagged
commit. A commit contained in `main` publishes under `latest`; a commit contained
only in `plumbus-next` publishes under `plumbus-next`. A tagged commit on no remote
branch fails instead of choosing an alias. Keep this beta release off `main` until
promotion is intended.

The workflow installs with the frozen lockfile and runs lint, format check, build,
typecheck and tests before publication, with PostgreSQL available for database
tests. It publishes all 24 packages in dependency order, including shared decision
contracts before core and adapters and payments before its Stripe provider. For
each package, it checks npm for that exact version: an existing version is skipped;
a missing version is published under the resolved dist-tag. Therefore unchanged
packages keep their versions, and publishing again cannot replace an existing
version's contents. A skipped package's dist-tags are not changed by the workflow.

Watch the **Publish to npm** workflow and wait for its successful completion, then
verify the registry:

```bash
gh run list --workflow publish.yml --limit 5
npm view @plumbus/core@plumbus-next version
npm view @plumbus/ai-decision@plumbus-next version
npm view @plumbus/ai-decision-typesafe@plumbus-next version
npm view @plumbus/ai-decision-laya@plumbus-next version
npm view @plumbus/ai-bedrock@plumbus-next version
npm view @plumbus/auth-cognito@plumbus-next version
npm view @plumbus/voice-livekit@plumbus-next version
npm view @plumbus/ai-decision-openai@plumbus-next version
npm view @plumbus/payments@plumbus-next version
npm view @plumbus/payments-stripe@plumbus-next version
npm view @plumbus/core dist-tags --json
```

Expect the package versions in the table, with core `plumbus-next` at
`0.8.0-beta.10` and core `latest` still at `0.7.9` for this release. Install the beta
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
