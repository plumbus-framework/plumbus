# Changelog

## 0.3.0-beta.0 — 2026-09-23 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.8.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.
- Same adapter as 0.2.2; the `@plumbus/core` peer is `>=0.8.0-beta.0 <0.9.0` and the shared contracts dependency is `@plumbus/ai-decision` `~0.3.0-beta.0`.

## 0.2.2 — Unreleased

- Document core 0.7.4+ classification with per-call provider/model and probability threshold. Link the packaged classification recipe from agent instructions and correct stale package-only guidance. Core peer compatibility remains `0.7.x`.

- Preserve model, usage, and known TypeSafe cost on malformed-answer errors so core 0.7.3 records billed failures. Keep unknown response models unpriced.
- Document native core registration and cost recording; existing core peer ranges remain unchanged.

## 0.2.0 — 2026-09-23

- Initial optional TypeSafe/Jev System One HTTP adapter for typed choices, scores, and probabilities, using `@plumbus/ai-decision` contracts and validation.
- Validate credentials/endpoints, normalize native answers, and handle bounded retries, cancellation, deadlines, and malformed responses with structured errors.
- Price the actual response model using bundled or configured input rates; return unknown cost explicitly and retain usage when pricing fails.
- Ship offline unit and HTTP tests, consumer agent instructions, and smoke tooling. Both decision adapters can be exercised against the local Laya reference service; this does not verify hosted TypeSafe authentication or billing.
- Requires core `0.7.x`. Core `ctx.ai.decide()`, provider registration, automatic budgets/auditing, and agent discovery remain deferred.
