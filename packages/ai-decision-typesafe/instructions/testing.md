# Testing

Use injected `fetch` for offline adapter tests. In consumer applications, test
business behavior through core's `runCapability()` / `simulateFlow()` and run
`plumbus test`; do not add separate Vitest or Zod dependencies.

In the framework repository, run `pnpm lint`, `pnpm format:check`,
`pnpm typecheck`, and `pnpm test`. Laya's offline service contract test needs
`python3` but imports no model libraries and downloads nothing.

For live tests, follow [Providing a live test environment](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md#providing-a-live-test-environment).
Provide a private env-file path, not pasted secrets. Set
`PLUMBUS_LIVE_DECISION_TESTS=1`, the provider key, and the reachable Laya base URL
when applicable. Run the provider's `scripts/smoke.mjs` from its monorepo directory
after building. Scripts are repository tools, not installed core CLI commands.

Validate choices, scores, probabilities, actual model/routing, usage and unknown
cost handling. Measure live accuracy and calibration separately from connection
success. Do not assert a universal confidence cutoff or guaranteed live label.

For core 0.7.4+ classification, use `mockAI({ classify: ['billing'] })` and test
through `runCapability()` / `simulateFlow()`. Integration tests should assert
provider/model forwarding, zero/multiple matches, inclusive thresholds, and one
`classify` cost row. Use injected fetch; routine tests do not require live Laya.

For core 0.7.3+ integration tests, configure `mockAI({ decide: result })` or a real
`createAIService({ decisions, costTracker, onAICostRecorded })` with injected
provider fetch. Assert exactly one cost row, identity, actual model/usage, unknown
cost handling, billed validation failures, and budget rejection before dispatch.
