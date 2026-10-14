# Changelog

## 0.4.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.4.0-beta.0 follows 0.3.0-beta.0 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.3.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/core` `>=0.9.0-beta.0 <0.10.0`; they stay prerelease-inclusive until the family goes stable.
- The shared contracts dependency is `@plumbus/ai-decision` `~0.4.0-beta.0` when packed (stable 0.3.0 uses `~0.3.0`).

### From the earlier betas

- The OpenAI Decisions adapter on the beta family, using shared decision contracts with endpoint-path and rounding support (0.3.0-beta.0).

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.3.0).
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.3.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`. This minor line makes the compatibility change an explicit upgrade.
- Update the shared `@plumbus/ai-decision` dependency to `~0.3.0` in the published package.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.3.0-beta.0 — core 0.8 beta family

- Carries the stable-line functionality below into the coordinated core 0.8 beta family, published under `plumbus-next`; `latest` stays on the 0.7 family. Install matching beta packages together; the core peer is `>=0.8.0-beta.0 <0.9.0`. See the [0.8 upgrade notes](../../docs/upgrading-core-0.9.md).
- Depends on `@plumbus/ai-decision` `~0.3.0-beta.1`, including the endpoint-path and rounding support required by the adapter.

## 0.2.0 — 2026-10-08

- Initial optional OpenAI Decisions API (`POST /v1/decisions`) adapter for typed choices, scores, and probabilities (#72), using `@plumbus/ai-decision` 0.2.3 contracts, validation, and the shared bounded HTTP transport. No OpenAI SDK dependency. OpenAI's Decisions API is in public beta; the adapter follows its documentation as of 2026-10-08 and may need a patch if the API changes at general availability.
- The adapter's provider name is `openai-decisions`, so its cost rows are distinct from rows of the `openai` text provider.
- Map `probability` questions to `predicate`, `choice` criteria to `choices`, and `score` criteria to ordered `levels`. Each Plumbus question key becomes the OpenAI question `name`. Answers are matched by name, and score levels are checked against the requested labels and indices.
- Accept two-decimal rounding in OpenAI's numbers: distributions that sum to 1 only within rounding, a chosen option that is within rounding of the top option, and a score that matches its distribution only within rounding. Options and levels that OpenAI leaves out count as probability 0. The chosen option is never changed. Unknown, repeated, or mistyped answers, options, and levels, probabilities outside [0, 1], and sums far from 1 still fail.
- A `refusal` answer fails the whole call with `invalid_response` and sets `error.refusedQuestions` to the refused question keys. Refusals and malformed answers keep the billed model, usage, and known cost, so core records the failed call.
- Price the actual response model with the bundled `gpt-6-luna` input rate ($0.10 / 1M tokens, verified 2026-10-08), doubled above 272K input tokens as OpenAI bills long prompts, or with configured `inputRates`, which are applied flat. Dated snapshots inherit their alias rate; unknown models return `cost: null`. Regional processing is not modeled.
- Ship offline adapter tests, consumer agent instructions (`instructions/`), and a one-request live smoke script (`scripts/smoke.mjs`, a repository tool that is not in the npm package).
- Requires core `0.7.x`; `ctx.ai.decide()` needs core 0.7.3+, `ctx.ai.classify({ provider })` needs 0.7.4+, and agent wiring v19 (core 0.7.9) links these instructions. Core checks results again with its own `@plumbus/ai-decision`, which must be 0.2.3+ for OpenAI's rounding: use core 0.7.9, or on core 0.7.3–0.7.8 run `pnpm dedupe` and check that `pnpm why @plumbus/ai-decision` lists one copy.
