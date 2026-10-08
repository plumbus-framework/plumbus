# Changelog

## 0.2.0 — Unreleased

- Initial optional OpenAI Decisions API (`POST /v1/decisions`) adapter for typed choices, scores, and probabilities, using `@plumbus/ai-decision` 0.2.3 contracts, validation, and the shared bounded HTTP transport. No OpenAI SDK dependency.
- Map `probability` questions to `predicate`, `choice` criteria to `choices`, and `score` criteria to ordered `levels`. Each Plumbus question key becomes the OpenAI question `name`. Answers are matched by name, and score levels are checked against the requested labels and indices.
- Report `refusal` answers and malformed answers as `invalid_response` errors that keep the billed model, usage, and known cost, so core records the failed call.
- Price the actual response model with the bundled `gpt-6-luna` input rate ($0.10 / 1M tokens, verified 2026-10-08) or configured `inputRates`; dated snapshots inherit their alias rate, unknown models return `cost: null`. Regional and long-context multipliers are not modeled.
- Requires core `0.7.x`; `ctx.ai.decide()` needs core 0.7.3+, `ctx.ai.classify({ provider })` needs 0.7.4+, and agent wiring v19 (core 0.7.9) links these instructions.
