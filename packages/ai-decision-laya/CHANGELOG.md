# Changelog

## 0.3.0-beta.0 — 2026-09-23 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.8.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.
- Same adapter and Python reference service as 0.2.2; the `@plumbus/core` peer is `>=0.8.0-beta.0 <0.9.0` and the shared contracts dependency is `@plumbus/ai-decision` `~0.3.0-beta.0`.
- The connection-capacity service test reads the over-capacity 503 without sending a request. The server refuses at accept before reading, so a client still writing its body could be reset first; the test failed about one run in ten.

## 0.2.2 — Unreleased

- Document core 0.7.4+ classification with per-call provider/model and probability threshold. Link the packaged classification recipe from agent instructions and correct stale package-only guidance. Core peer compatibility remains `0.7.x`.

- Run offline Laya tests with one worker and serial files. One-off smoke runs now stop servers they start on both success and failure; explicit persistent servers and the model cache are preserved.

- Preserve model, usage, and configured infrastructure cost on malformed-answer errors. Update the local smoke app to use ctx.ai.decide() and verify scoped ledger records.
- Synchronize the connection-capacity regression test with server-handler cleanup before checking that a slot can be reused.
- Document native core registration and cost recording; existing core peer ranges remain unchanged.

## 0.2.0 — 2026-09-23

- Initial optional self-hosted Laya HTTP adapter for typed choices, scores, and probabilities, using `@plumbus/ai-decision` contracts and validation.
- Ship a persistent Python reference service pinned to Laya `0.3.5` and a CPU Dockerfile. Support preloaded English, multilingual, and typed-decision checkpoints with explicit routing identity and token-budget preflight checks.
- Bound request/response sizes, JSON depth, HTTP handler capacity, and concurrent inference. Validate bearer authentication, content metadata, and message framing, and handle client disconnects.
- Add a repository smoke example that manages a local server/password, retains the model cache with correct ownership, and tests both decision adapters with real inference.
- Ship offline adapter tests, Node-to-Python HTTP tests, Python service tests, and consumer agent instructions. Python/model dependencies are installed separately from pnpm.
- Give the combined Python contract suite an explicit Vitest timeout longer than its subprocess deadline, avoiding false failures under parallel workspace load.
- Requires core `0.7.x`. Core `ctx.ai.decide()`, provider registration, automatic budgets/auditing, and agent discovery remain deferred.
