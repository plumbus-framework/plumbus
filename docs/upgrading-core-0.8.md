# Upgrading to core 0.8 (beta)

Core 0.8 is the next coordinated release family after the 0.7 security release. It carries breaking changes, so every package moves to a new minor line and the family is first published as **`-beta.N` prereleases under the npm `beta` dist-tag**. `latest` keeps pointing at the 0.7 family until the beta is promoted.

## Packages to publish

| Package | Previous (latest) | Beta |
| --- | --- | --- |
| `@plumbus/core` | 0.7.1 | 0.8.0-beta.0 |
| `@plumbus/ui` | 0.8.1 | 0.9.0-beta.0 |
| `@plumbus/mcp` | 0.6.1 | 0.7.0-beta.0 |
| `@plumbus/voice` | 0.5.1 | 0.6.0-beta.0 |
| `@plumbus/ai-bedrock` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/api` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/auth` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/auth-cognito` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/browser-extension` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/chat` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/chat-ui` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/knowledge-base` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-deepdub` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-elevenlabs` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-livekit` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-minimax` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-openai` | 0.2.1 | 0.3.0-beta.0 |
| `@plumbus/voice-soniox` | 0.2.1 | 0.3.0-beta.0 |

All 18 packages move outside their previous caret range, including add-ons whose only change is the peer literal: every add-on peers on core, and a `0.7.x` peer would reject core 0.8. Canonical peer literals are in [peer dependencies](../packages/plumbus-core/instructions/peer-dependencies.md).

## Prerelease peers

Semver ranges such as `0.8.x` do not match `0.8.0-beta.0`. During the beta every internal peer therefore uses a closed range, for example `">=0.8.0-beta.0 <0.9.0"` for core. That range accepts the betas and every later stable `0.8.N`, and still rejects 0.7.x. The stable release replaces those literals with the plain `0.8.x` form in the same commit that removes the `-beta` suffixes.

## Installing the beta

Select the beta family explicitly for every installed Plumbus package in one dependency change:

```bash
npm install @plumbus/core@beta @plumbus/ui@beta @plumbus/voice@beta @plumbus/voice-livekit@beta
```

Do not mix beta packages with the 0.7 family, and do not use `--force` or `--legacy-peer-deps` to hide a mixed-family error. Existing lockfiles that pin `^0.7.x` are unaffected.

## Breaking changes in this family

| Area | Who needs to act | Required action |
| --- | --- | --- |
| Action-risk vocabulary | Capabilities declaring `actionRisk: 'read-only'` | Use `analytical`. `read-only` is a retired value and `defineCapability` rejects it. `prohibited` is normative: the approval gate refuses prohibited capabilities outright and they cannot be exposed as MCP tools or API routes. |
| Listen ports | Apps relying on default ports 3000/3001 | `plumbus e2e --port`, `plumbus worker --health-port`, `plumbus mcp serve --http --port`, `createServer({ port })`, and `startHttpServer({ port })` require an explicit port (or the matching `PLUMBUS_*_PORT` variable). |
| `plumbus ui generate` | Projects without a detected frontend | Pass `--out-dir`; `.plumbus/generated/ui` is no longer a silent default. Fetch clients, hooks, and form hints are emitted only for `exposeAs: ['api']` capabilities. |
| `plumbus generate` | Tooling that parsed the generated OpenAPI 3.0 document | `.plumbus/generated/openapi.json` is OpenAPI 3.1.0 with JSON Schema 2020-12 nullables. Leftover `.plumbus/generated/clients/` trees are deleted on the next run. |
| Flow compensations | Executions whose stored auth snapshot is missing or invalid | Compensations run as the verified initiating identity, never as the worker. An invalid snapshot records a failed `compensate` history entry and a `flow.compensation_skipped` audit event for operator review. |
| Reasoning configuration | Apps that used the widened legacy `reasoningEffort` values | Use the provider-neutral `reasoning` config from the 0.7 family. `REASONING_EFFORTS` / `ReasoningEffortOption` remain the vocabulary of `ProviderModel.reasoningEfforts` metadata. |

No database schema changes are introduced by this family beyond the tenant data-plane helpers, which are opt-in.

## Publication

- The publish workflow runs when a `v*` Git tag is pushed. Repository release tags are numbered independently from package versions; never move or reuse an existing release tag.
- The workflow publishes any version containing `-` under the `beta` dist-tag and everything else under `latest`. Promoting a beta to `latest` is a separate operator decision after the whole family and consumer staging checks pass.
- Run the four repository gates (lint, format check, typecheck, tests) and the packed npm consumer install from the [security release runbook](./upgrading-security-release.md#release-preparation-checks) before tagging.
