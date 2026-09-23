# Changelog

## 0.2.0 — 2026-09-23

- Initial optional TypeSafe/Jev System One HTTP adapter for typed choices, scores, and probabilities, using `@plumbus/ai-decision` contracts and validation.
- Validate credentials/endpoints, normalize native answers, and handle bounded retries, cancellation, deadlines, and malformed responses with structured errors.
- Price the actual response model using bundled or configured input rates; return unknown cost explicitly and retain usage when pricing fails.
- Ship offline unit and HTTP tests, consumer agent instructions, and smoke tooling. Both decision adapters can be exercised against the local Laya reference service; this does not verify hosted TypeSafe authentication or billing.
- Requires core `0.7.x`. Core `ctx.ai.decide()`, provider registration, automatic budgets/auditing, and agent discovery remain deferred.
