# Changelog

## 0.2.3 — 2026-10-08

- `createDecisionHttpTransport(provider, config, { path })` accepts an optional endpoint path appended to `baseUrl` (default `systemone`). Paths are relative segments of letters, digits, `_` and `-`; anything else is a configuration error. Used by `@plumbus/ai-decision-openai` for `POST /v1/decisions`. Existing adapters are unchanged.
- An adapter can declare `rounding`, the decimal step (at most 0.01) its probabilities and scores are rounded to. The runtime passes it to `validateDecisionResult()` / `parseDecisionResponse()` (new optional `{ rounding }` argument), which then accept a distribution sum, a chosen option's gap to the top option, and a score's gap to its distribution that are within that rounding. The sum allowance grows with the option count only up to ten options. Structural checks are unchanged. An invalid `rounding` is a configuration error before dispatch. Without it, validation is exactly as before (four decimal places, as Laya rounds), so TypeSafe and Laya are unaffected. `@plumbus/ai-decision-openai` declares 0.01.
- `DecisionProviderError` has an optional `refusedQuestions` field that lists the question keys a provider declined to answer. Refusals keep `kind: 'invalid_response'`, so existing error handling and core 0.7.x keep working.

## 0.2.2 — 2026-09-23

- Document core 0.7.4+ classification with per-call provider/model and probability threshold. Link the packaged classification recipe from agent instructions and correct stale package-only guidance. Core peer compatibility remains `0.7.x`.

- Harden decision dispatch against mutable provider identity/questions, broken error metadata accessors, inconsistent selector normalization, hidden discovered definitions, and oversized requests before provider work.

- Add named frozen decision contracts, a registry, normalized-result validation, and the shared runtime used by core 0.7.3 for security, budgets, cancellation, and cost recording. Publish a dependency-free type entry for core compilation.
- Document native core registration and cost recording; existing core peer ranges remain unchanged.

## 0.2.0 — 2026-09-23

- Initial shared package for typed choices, ordinal scores, and probabilities, with inferred answer types and runtime request/response validation.
- Validate bounded JSON, UTF-8, duplicate keys, score rubrics, and probability distributions. Preserve known model/usage metadata on answer-validation errors.
- Provide structured errors and HTTP transport with bounded responses, deadlines, cancellation, retry hints, and cleanup. Redirects are disabled to protect credentials.
- Ship offline contract/transport tests and consumer agent instructions. Requires core `0.7.x`; provider packages install this dependency transitively.
- This is package-only support. Core `ctx.ai.decide()`, provider registration, automatic budgets/auditing, and agent discovery remain deferred.
