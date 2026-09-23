# Changelog

## 0.2.1 — Unreleased

- Harden decision dispatch against mutable provider identity/questions, broken error metadata accessors, inconsistent selector normalization, hidden discovered definitions, and oversized requests before provider work.

- Add named frozen decision contracts, a registry, normalized-result validation, and the shared runtime used by core 0.7.3 for security, budgets, cancellation, and cost recording. Publish a dependency-free type entry for core compilation.
- Document native core registration and cost recording; existing core peer ranges remain unchanged.

## 0.2.0 — 2026-09-23

- Initial shared package for typed choices, ordinal scores, and probabilities, with inferred answer types and runtime request/response validation.
- Validate bounded JSON, UTF-8, duplicate keys, score rubrics, and probability distributions. Preserve known model/usage metadata on answer-validation errors.
- Provide structured errors and HTTP transport with bounded responses, deadlines, cancellation, retry hints, and cleanup. Redirects are disabled to protect credentials.
- Ship offline contract/transport tests and consumer agent instructions. Requires core `0.7.x`; provider packages install this dependency transitively.
- This is package-only support. Core `ctx.ai.decide()`, provider registration, automatic budgets/auditing, and agent discovery remain deferred.
