# Changelog

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
