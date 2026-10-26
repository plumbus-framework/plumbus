# Changelog

## 0.4.0-beta.1 — 2026-10-26

- **zod 4.** `inputRates` uses `@plumbus/ai-decision`'s `narrow` and a keyed `z.record`. Core peer `>=0.9.0-beta.6 <0.10.0`.

## 0.4.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.4.0-beta.0 follows 0.3.0-beta.1 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.3.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/core` `>=0.9.0-beta.0 <0.10.0`; they stay prerelease-inclusive until the family goes stable.
- The shared contracts dependency is `@plumbus/ai-decision` `~0.4.0-beta.0` when packed (stable 0.3.0 uses `~0.3.0`).

### From the earlier betas

- Shared decision contracts with endpoint-path and rounding support and a refreshed provider README (0.3.0-beta.1). TypeSafe response validation stays strict; runtime behavior is unchanged.

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.3.0).
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.3.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`. This minor line makes the compatibility change an explicit upgrade.
- Update the shared `@plumbus/ai-decision` dependency to `~0.3.0` in the published package.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.3.0-beta.1 — 2026-10-12

- Require shared decision contracts `~0.3.0-beta.1` when packed and refresh the provider README. TypeSafe response validation remains strict and runtime behavior is unchanged.

## 0.3.0-beta.0 — 2026-09-23 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.9.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.
- Same adapter as 0.2.2; the `@plumbus/core` peer is `>=0.8.0-beta.0 <0.9.0` and the shared contracts dependency is `@plumbus/ai-decision` `~0.3.0-beta.0`.

## 0.2.3 — 2026-10-08

- The README now uses the standard Plumbus package format (badges, Why?, What you get, When to use this vs alternatives, Status, Pricing, Configuration, Key gotchas, Links), keeping all of its earlier content. Runtime behavior and the core peer range are unchanged from 0.2.2.
- The published dependency on `@plumbus/ai-decision` is now `~0.2.3` (was `~0.2.2`), following the shared package's current version. Shared 0.2.3 validates TypeSafe answers exactly as 0.2.2 did.

## 0.2.2 — 2026-09-23

- Document core 0.7.4+ classification with per-call provider/model and probability threshold. Link the packaged classification recipe from agent instructions and correct stale package-only guidance. Core peer compatibility remains `0.7.x`.

- Preserve model, usage, and known TypeSafe cost on malformed-answer errors so core 0.7.3 records billed failures. Keep unknown response models unpriced.
- Document native core registration and cost recording; existing core peer ranges remain unchanged.

## 0.2.0 — 2026-09-23

- Initial optional TypeSafe/Jev System One HTTP adapter for typed choices, scores, and probabilities, using `@plumbus/ai-decision` contracts and validation.
- Validate credentials/endpoints, normalize native answers, and handle bounded retries, cancellation, deadlines, and malformed responses with structured errors.
- Price the actual response model using bundled or configured input rates; return unknown cost explicitly and retain usage when pricing fails.
- Ship offline unit and HTTP tests, consumer agent instructions, and smoke tooling. Both decision adapters can be exercised against the local Laya reference service; this does not verify hosted TypeSafe authentication or billing.
- Requires core `0.7.x`. Core `ctx.ai.decide()`, provider registration, automatic budgets/auditing, and agent discovery remain deferred.
