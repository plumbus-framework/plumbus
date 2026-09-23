# Upgrading to core 0.8 (beta)

Core 0.8 is the next coordinated release family after the 0.7 security release. It carries breaking changes, so every package moves to a new minor line and the family is first published as **`-beta.N` prereleases under a branch-named npm dist-tag** (`plumbus-next` while it is tagged from that branch). `latest` keeps pointing at the 0.7 family until the beta is promoted.

## Packages to publish

| Package | Previous (latest) | Beta |
| --- | --- | --- |
| `@plumbus/core` | 0.7.4 | 0.8.0-beta.6 (beta.5 + core 0.7.2/0.7.4 from `main`: typed decisions through `ctx.ai.decide()`, `ctx.ai.classify()` provider/model routing, agent wiring v17, structured answers with native tools, Claude Opus 5.5 and GPT-6 pricing; generated OpenAPI documents a declared `api.method`) |
| `@plumbus/ui` | 0.8.1 | 0.9.0-beta.1 (beta.0 + flow triggers only for descriptors with an explicit `startPath`) |
| `@plumbus/mcp` | 0.6.1 | 0.7.0-beta.0 |
| `@plumbus/voice` | 0.5.2 | 0.6.0-beta.1 (beta.0 + voice 0.5.2: `resolveSttContext`, `tts.responseMode: 'reply'`, STT error recovery, `transcript.maxChars`) |
| `@plumbus/ai-bedrock` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/api` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/auth` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/auth-cognito` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/browser-extension` | 0.2.1 | 0.3.0-beta.1 (beta.0 + scaffolding filtered to the served HTTP surface) |
| `@plumbus/chat` | 0.2.2 | 0.3.0-beta.1 (beta.0 + chat 0.2.2: structured custom-agent output through `onAgentOutput`) |
| `@plumbus/chat-ui` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/knowledge-base` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-deepdub` | 0.2.2 | 0.3.0-beta.1 (beta.0 + default model `dd-etts-3.3`) |
| `@plumbus/voice-elevenlabs` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-livekit` | 0.2.2 | 0.3.0-beta.1 (beta.0 + 20 ms PCM framing, text streams for events above 15 KiB) |
| `@plumbus/voice-minimax` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-openai` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-soniox` | 0.2.2 | 0.3.0-beta.1 (beta.0 + per-session recognition context, STT error callback) |
| `@plumbus/ai-decision` | 0.2.2 | 0.3.0-beta.0 (joins the family with core 0.8.0-beta.6, which depends on it) |
| `@plumbus/ai-decision-typesafe` | 0.2.2 | 0.3.0-beta.0 |
| `@plumbus/ai-decision-laya` | 0.2.2 | 0.3.0-beta.0 |

All 21 packages move outside their previous caret range, including add-ons whose only change is the peer literal: every add-on peers on core, and a `0.7.x` peer would reject core 0.8. Canonical peer literals are in [peer dependencies](../packages/plumbus-core/instructions/peer-dependencies.md).

Since 0.8.0-beta.6 core has a regular dependency on `@plumbus/ai-decision` (`~0.3.0-beta.0`, the shared decision contracts). The publish workflow publishes that package before core; a core 0.8.0-beta.6 install cannot resolve until `@plumbus/ai-decision@0.3.0-beta.0` is on npm. The TypeSafe and Laya adapters stay optional installs.

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

### Additive in this family

| Area | Who it is for | What changed |
| --- | --- | --- |
| Host data-plane resolver | Hosts that route tenant data themselves and want flow state on the tenant plane | `app/server.ts` may export `dataPlaneResolver`, `listTenantRefs`, `untenantedDataPlane`, `requestDataPlane`, `workerDataPlane` and `resolveTenantRef`; `plumbus dev` / `start` / `worker` pass them to `createServer` and the worker pool. Request-side flow engines then carry `spineDispatch`, so a flow a request starts is written to the tenant plane with an opaque hint on the control plane. `FlowSpineDispatchConfig.untenanted: 'control-plane'` lets control-plane flows (no tenant) stay classic spine rows claimed beside the tenant hints; `requestDataPlane: 'control-plane'` keeps request repositories on the boot connection, and `workerDataPlane: 'control-plane'` does the same for claimed units (`WorkerPoolConfig.unitDataPlane`). Under `'resolved'`, a `tenantScoped: false` capability now reads the control plane even for a tenant-bound request. `retryDeadLetteredFlow` takes an optional `placement` (`{ spineDb, coreSchema? }`) that reopens a tenant-placed execution and publishes a fresh spine hint (`republished` on the result); `engine.cancel` and the runner's failure finaliser close the durable state of a tenant-placed execution, and a claim drops the hint of a terminal row instead of reviving it. Follow-up hints between drained steps are published under the running worker's lease; acknowledged hints close their outbox rows; the outbox pump publishes only never-published rows (it used to re-ready every unacknowledged row on each poll, clearing live leases); a hint whose plane fails to resolve is dead-lettered after `maxClaimAttempts` claims; the worker's engine now carries `untenanted` on its spine dispatch, so control-plane rows are claimed beside the hints. See [Tenant Data Planes](sdk-reference/tenant-data-planes.md). |
| AI provider admission and trace propagation | Hosts that meter or trace outbound model calls | `app/server.ts` may export `aiProviderConcurrency` (immediate per-scope ceiling, default scope provider + tenant + `costContext.serviceArea`; saturation throws `ai-provider-concurrency-exhausted` with `retryAfterSeconds: 1`, never queues), `resolveAIProviderHeaders` (trusted W3C `traceparent` / `tracestate` for every provider attempt, reaching the adapter as `ProviderRequest.transportHeaders`; credential and content-type headers are refused) and `onAIProviderSpan` (best-effort client-span export). `createAIService` takes the same as `providerConcurrency` / `resolveProviderHeaders` / `onProviderSpan`; `withContext` accepts `correlationId` and flow workers bind the persisted flow correlation id. See [AI integration](ai/ai-integration.md#provider-admission-and-trace-propagation). |
| `ctx.flows.terminate` | Operator recovery capabilities | `FlowService` exposes the engine's `terminate(executionId)`: abort and close as `cancelled` without compensations, beside `cancel`, which runs every declared compensation. See [Flows](core-concepts/flows.md#cancellation). |
| Approval request cancellation | Hosts with human-approval workflows | `ApprovalService.cancel({ requestId, auth, reason })` withdraws a still-pending request after human-actor and host-authorization revalidation, records cancellation evidence, and atomically cancels linked open/claimed human tasks without writing an approval decision. Tenant durable migration `0002_approval_cancellation.sql` adds the evidence columns. See [Approvals](core-concepts/approvals.md). |
| Typed decisions and classification | Apps that call TypeSafe/Jev or self-hosted Laya decision providers | Since core 0.8.0-beta.6, `ctx.ai.decide()` runs a decision adapter over the shared `@plumbus/ai-decision` contract with security checks, budgets, cancellation and per-call cost records through `onAICostRecorded`, and `ctx.ai.classify()` takes optional `provider` / `model` to route labels to a text provider or a decision adapter (labels at or above `threshold`, default 0.5). Register providers with `export const decisions = { providers, defaultProvider }` in `app/server.ts`; named definitions live under `app/decisions/`. Install the adapter packages (`0.3.0-beta.0`) explicitly. Run `plumbus init --patch --agent all` for agent wiring v17, which links the classification recipe. See [Decision providers](ai/decision-providers.md). |
| Events audit vocabulary | Every host | The dispatcher and the event worker record their audit with the outcomes `createAuditService` accepts (`success` / `failure` / `denied`); `event.dispatch.attempt`, `event.consumer.attempt` and `event.consumer.skipped` carry no outcome, `event.dispatch.failed` and `event.consumer.dead_lettered` are `failure` (the former adds `disposition: retry \| dead_lettered`). Before, they wrote `pending` / `retry` / `dead_lettered` / `skipped`, which the audit service refused — so with the real audit service every dispatch attempt threw, and one plane's rejected poll escaped the timer and ended the worker process. The outbox poll now contains a failing plane and keeps polling the others. |

No database schema changes are introduced by this family beyond the tenant data-plane helpers and the approval-cancellation evidence columns, which are opt-in — a host enabling spine dispatch needs the framework's `opaque_dispatch` table on its control plane (`migrations/spine/0000_opaque_dispatch.sql`) and the `core_plumbus` durable tables on each tenant plane (the generator already emits them). Hosts that store approval requests and want `ApprovalService.cancel` need `migrations/durable-tenant/0002_approval_cancellation.sql` on each tenant plane.

## Publication

- The publish workflow runs when a `v*` Git tag is pushed. Repository release tags are numbered independently from package versions; never move or reuse an existing release tag.
- The workflow derives the dist-tag from the branch containing the tagged commit: `latest` for `main`, otherwise the branch name. Push the branch before the tag; a tag whose commit is on no branch fails the run. Promoting a beta to `latest` is a separate operator decision after the whole family and consumer staging checks pass.
- Run the four repository gates (lint, format check, typecheck, tests) and the packed npm consumer install from the [security release runbook](./upgrading-security-release.md#release-preparation-checks) before tagging.
