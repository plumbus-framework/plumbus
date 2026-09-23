# Changelog

## 0.3.0-beta.0 — 2026-09-23 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.8.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.
- Same contracts, validation, transport and decision runtime as 0.2.2; the `@plumbus/core` peer is `>=0.8.0-beta.0 <0.9.0`. Core 0.8.0-beta.6 depends on this package (`~0.3.0-beta.0`) for `ctx.ai.decide()` and decision-backed `ctx.ai.classify()`.

## 0.2.2 — Unreleased

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
