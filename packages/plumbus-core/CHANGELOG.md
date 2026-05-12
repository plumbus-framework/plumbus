# @plumbus/core changelog

## 0.3.0

### Added

- `AICostContext` type (in `@plumbus/core` ai module barrel) — optional
  per-call billing metadata (`projectId`, `serviceArea`, `operationName`,
  `relatedEntityType`, `relatedEntityId`) you can pass to every
  `ctx.ai.generate*` / `ctx.ai.extract` / `ctx.ai.classify` /
  `ctx.ai.streamGenerate` call.
- `AIServiceConfig.onAICostRecorded` and
  `ServerConfig.onAICostRecorded(record, costContext, db)` hooks — fired
  after every AI call completes (success *or* failure) and the in-memory
  cost tracker has been updated. Use this to persist a ledger row per
  provider round-trip so sunk spend on retries is visible.
- `AICostRecord.status: 'success' | 'failed'` and
  `AICostRecord.errorMessage?: string` — new fields on cost records so
  failures are distinguishable from successes.
- `AICostRecordInput` — explicit input type for `CostTracker.record`,
  keeps `status` optional so pre-0.3.0 call sites keep compiling.
- `AIValidationError` now carries `usage: TokenUsage`, `model: string`,
  and `provider: string` so failure-path cost recording knows what the
  provider actually billed across the retry loop.
- **`ChatMessage` type** and optional **`messages`** on `ctx.ai.generate`,
  `ctx.ai.generateWithUsage`, and **`ctx.ai.streamGenerate`**. When `messages`
  is a non-empty array of `{ role: 'user' | 'assistant', content }` turns,
  OpenAI and Anthropic adapters send the thread natively instead of folding
  everything into a single user message built from `prompt`. The rendered
  prompt description (`buildBasePrompt`) is merged into the provider **`system`**
  instruction so per-turn template context is preserved; `prompt` is not used
  as an extra user turn in that mode. Sub-agents and single-turn callers can
  omit `messages` unchanged.

### Changed

- `costTracker.record(...)` now ALSO fires on the failure path when usage
  is known (e.g. via `AIValidationError.usage`). Previously the in-memory
  tracker only recorded successful calls, which under-counted sunk spend.
  Consumers who configured `budget.dailyCostLimit` will see failed-call
  tokens start contributing to the daily running total. Tight ceilings
  may deny retries sooner on failure-heavy workloads. This is considered
  a bug fix (sunk provider spend is real spend), but it is observable —
  hence the minor version bump.

### Migration

No code changes required for consumers upgrading from `0.2.x`:

- Existing `costTracker.record({ model, provider, usage, cost, ... })`
  calls without `status` keep compiling and default to `'success'`.
- Existing `catch (err) { ... }` blocks reading `err.attempts`,
  `err.rawOutput`, or `err.validationMessage` from `AIValidationError`
  are unaffected — the new fields are additive.
- Existing `ServerConfig` usages without `onAICostRecorded` are
  unaffected — the hook is optional, no hook installed = no behavior
  change.

To opt into the new failure-ledger persistence:

1. Pass `costContext: { projectId, ... }` on your `ctx.ai.*` calls.
2. Install `onAICostRecorded` in `createServer({ ... })` and write the
   `record` (with its `status`) to your persistent ledger.

For chat-style prompts (optional):

- Build `messages` from your transcript (roles `user` / `assistant` only)
  and pass it alongside `input` for template substitution. Ensure the
  **last** message is a `user` turn when the model should reply to the latest
  subject input. No code changes required for consumers that never pass
  `messages`.
