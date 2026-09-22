# @plumbus/ai-typesafe

## 0.1.0 — 2026-09-22 — initial release

### Added

- **`createTypeSafeDecisionAdapter`** — TypeSafe Jev adapter implementing core's `DecisionProviderAdapter` over `POST /v1/systemone`. Serves `ctx.ai.decide()`: typed noul / choice / score questions answered with calibrated probabilities and confidence. Returns the **versioned** model id that answered, so an alias like `jev-latest` is traceable to `jev-1.13.0` in the ledger.
- **`createTypeSafeAdapter`** — `AIProviderAdapter` declaring `capabilities.nativeClassify` and implementing the optional `classify` hook, so `ctx.ai.classify()` runs on Jev. Asks **one noul per label in a single request** (with explicit yes/no criteria) and keeps labels at or above `labelThreshold` (default `0.5`), preserving `classify()`'s multi-label contract. `complete()` / `stream()` / `embed()` reject with `AIInvalidRequestError` naming the surface to use instead.
- **`JEV_CAPABILITIES`** — declared provider limits (255 choice options, 2–10 score levels, 64k tokens for state plus all questions, 32k for state plus the longest question). Core validates questions against these **before** network I/O, so a malformed rubric fails locally with the offending question id instead of as a provider `422`.
- **Package-owned pricing** — Jev is charged at $42/Btok of input ($0.042/MTok) with **free output tokens**. The adapter sets `cost` on every response and `createAIService` prefers it over core's catalog. An unreleased `jev-*` version falls back to the shared rate; a non-Jev model name returns no `cost` so the catalog applies rather than recording a wrong zero.
- **`listModels()`** on both adapters — `GET /v1/models` with release metadata. Reported as `kind: 'decision'`, so a `listModels({ kind: 'text' })` call does not leak a decision model into a text-model picker. Returns `[]` and warns on failure rather than throwing.
- **Error mapping** — SDK errors become core's `ProviderAPIError` with `retryable` set only for `429`, `5xx`, and connection failures. Retries and `retry-after` handling stay with the SDK; Plumbus adds no second layer. A caller abort (`APIUserAbortError`) passes through untouched so a deliberate cancellation is not recorded as an outage.
- **Optional peer of `@plumbus/core` `0.7.x`** — wire via env (`AI_TYPESAFE_API_KEY` + `AI_DECISION_PROVIDER=typesafe`) or programmatically through `createAIService({ decisionProviders })`. The slot also accepts the SDK-native `TYPESAFE_API_KEY`.
- **Agent instructions** — `instructions/README.md`, `framework.md`, `decisions.md`, `testing.md` ship in the tarball. Run `plumbus init --patch` (wiring v17) after install so coding agents discover them.

### Notes

- Requires Node ≥ 20.6.0 and `@typesafe-ai/sdk` `^0.6.0` (bundled as a dependency).
- Jev generates no text. Keep OpenAI, Anthropic, or Bedrock registered as `AI_DEFAULT_PROVIDER` for `generate()` / `streamGenerate()` / `extract()` / embeddings.
