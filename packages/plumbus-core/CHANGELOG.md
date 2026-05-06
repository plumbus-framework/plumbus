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
