# Testing

Use injected `fetch` for offline adapter tests. Respond with the Decisions API shape:
`{ model, usage: { input_tokens, output_tokens }, answers: [{ type, name, ... }] }`,
one answer per question, named by the Plumbus question key. In consumer applications,
test business behavior through core's `runCapability()` / `simulateFlow()` and run
`plumbus test`; do not add separate Vitest or Zod dependencies.

For core 0.7.4+ classification, use `mockAI({ classify: ['billing'] })` and test
through `runCapability()` / `simulateFlow()`. Integration tests with a real
`createAIService({ decisions, onAICostRecorded })` should assert the
`openai-decisions` provider/model forwarding, threshold behavior, one `classify` cost
row, refusal handling, and unknown-cost handling.

In the framework repository, run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
and `pnpm test`. No credentials or network access are required.

For one live request, follow [Providing a live test environment](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md#providing-a-live-test-environment).
Provide a private env-file path, not pasted secrets, containing
`PLUMBUS_LIVE_DECISION_TESTS=1` and `OPENAI_API_KEY` (optionally `OPENAI_DECISION_MODEL`
and `OPENAI_BASE_URL`). After building, run `scripts/smoke.mjs` from the package
directory. It sends one fixed, non-sensitive ticket with three questions. The script
is a repository tool, not an installed CLI command.

Measure live accuracy and calibration separately from connection success. Do not
assert a universal confidence cutoff or a guaranteed live label.
