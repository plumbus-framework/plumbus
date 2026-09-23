# Changelog

## 0.2.0 — 2026-09-23

- Initial shared package for typed choices, ordinal scores, and probabilities, with inferred answer types and runtime request/response validation.
- Validate bounded JSON, UTF-8, duplicate keys, score rubrics, and probability distributions. Preserve known model/usage metadata on answer-validation errors.
- Provide structured errors and HTTP transport with bounded responses, deadlines, cancellation, retry hints, and cleanup. Redirects are disabled to protect credentials.
- Ship offline contract/transport tests and consumer agent instructions. Requires core `0.7.x`; provider packages install this dependency transitively.
- This is package-only support. Core `ctx.ai.decide()`, provider registration, automatic budgets/auditing, and agent discovery remain deferred.
