# @plumbus/core changelog

## 0.4.0

### Added

- **MCP exposure** — optional `exposeAs: ['mcp']` and `mcp?: { description?, dangerous?, agentTags? }` on capabilities; validation when MCP-exposed; `isMcpExposed()` helper.
- **`@plumbus/core/mcp`** — `buildMcpManifest`, `renderSkillFile`; `plumbus generate` writes `mcp-manifest.json` and `skills/<domain>/<kebab>.md`.
- **`zodInputToJsonSchema()`** — exported from `@plumbus/core` for MCP/OpenAPI-style JSON Schema from Zod inputs.
- **`@plumbus/mcp`** — separate, optional runtime package. Declared as an optional peer dependency of `@plumbus/core` (version-locked `0.4.x`). Install with `pnpm add @plumbus/mcp` when you want to serve capabilities to AI agents; `@plumbus/core` works without it.
- **CLI `plumbus mcp`** — `serve` (stdio / HTTP), `generate`, `list-tools`. `serve` lazy-loads `@plumbus/mcp` and prints a friendly install hint if the package is missing.
- **`PlumbusConfig.mcp.agents`** — static agent token map for MCP auth (see `docs/mcp/agent-authentication.md`).
- **Governance** — advisory rule for MCP-exposed capabilities missing agent-facing descriptions.
- **Consumer AI guidance includes MCP** — `plumbus init` now wires a new `instructions/mcp.md` reference into Copilot, Cursor, and AGENTS.md so coding agents in consumer projects discover `exposeAs: ['mcp']`, `plumbus mcp serve`, and agent auth. Scaffolded capabilities include a commented-out MCP block as a discoverable next step. `AGENT_WIRING_VERSION` bumped to 3.

### Upgrading existing projects

If you ran `plumbus init` on an earlier version, your `.cursor/rules/`, `.github/copilot-instructions.md`, and `AGENTS.md` files were generated against `AGENT_WIRING_VERSION` 2 and do not reference the new MCP instruction. To pick up the MCP guidance (and any future framework-managed additions), run:

```bash
plumbus init --patch       # replaces only the Plumbus-managed block; preserves your edits outside the markers
# or
plumbus agent sync          # same as --patch plus refreshes .plumbus/briefs/project.md
```

Use `--dry-run` to preview, or `--force` to replace the entire file.

### Non-breaking

- Capabilities without `exposeAs: ['mcp']` behave identically on HTTP and in tests.
- Upgrading `@plumbus/core` does **not** install `@plumbus/mcp`; install it explicitly when you want MCP support.
- `plumbus init --patch` only replaces content between the `plumbus:agent-wiring` markers — user-written content outside those markers is preserved.

## Unreleased — security hardening

### Security

- **Flow conditions** use a sandboxed expression evaluator (`evaluateFlowCondition`) instead of `new Function` (no arbitrary JS).
- **`auth.internal` removed as a god-mode bypass** — flow engine uses the `system` role; capabilities must list `system` in `access.roles` (included in scaffold).
- **`define*()` outputs are deep-frozen** (nested plain objects/arrays); Zod schemas and handlers are not frozen.
- **HTTP/SSE errors** expose only whitelisted `metadata` keys (`field`, `hint`, `reason`, `docUrl`, `httpStatus`, `retryAfter`, …); internal errors return a generic message.
- **CLI `.env` load** only runs inside a Plumbus project (`config/app.config.ts` or `plumbus.config.*`).
- **AI env providers** limited to `openai` and `anthropic` only; local Ollama uses `AI_OPENAI_BASE_URL` (no URL validation).
- **`translation import`** rejects paths outside the project root.
- **Workers** no longer set `bypassTenantScope` when `tenantId` is absent.
- **JWT adapter** requires secrets ≥ 32 characters.
- **Hook failures** (`onCapabilityError`, `onAICostRecorded`, process error hooks) are logged instead of swallowed.

### Fixed

- AI explainability `validation.passed` reflects whether validation succeeded on the first attempt.
- `define*()` validation throws `PlumbusError` with `code: validation`.

### Developer experience

- **`AGENT_WIRING_VERSION` 4** — `plumbus init` references `@plumbus/knowledge-base/instructions/*` (conventions, defining-sources, providers, chat-integration, testing, README) alongside core, UI, and chat. Run `plumbus init --patch` to refresh existing agent wiring files.
- Centralized `ErrorHints` / `ErrorDocUrls` for flow conditions, tenant denials, and CLI messages.
- `DatabaseConnection` + `resolveDatabaseConnection()` used by `plumbus start` / `plumbus dev`.
- Migration snapshot parsing covered by unit tests (`migrate-snapshot-schema`).

### Migration notes

| Change | Action |
|--------|--------|
| Flow `if` expressions | Use `state.field` comparisons (`state.amount > 100`). `ctx.state.*` is normalized automatically. No method calls or arbitrary JS. |
| `AI_OLLAMA_*` / other `AI_*_API_KEY` | Use `AI_OPENAI_API_KEY` + `AI_OPENAI_BASE_URL=http://…/v1` |
| Capabilities called from flows | Ensure `access.roles` includes `"system"` |
| Custom `AI_*` providers in env | Only `openai` and `anthropic` are registered |
| Relying on missing `tenantId` + cross-tenant data in flows | Provide `tenantId` on flow execution or use `access.tenantScoped: false` for admin capabilities |

## 0.3.0

### Upgrade checklist

Read this before bumping to 0.3.0 — there is one mandatory step.

1. **Run migrations.** 0.3.0 adds `lease_owner` and `lease_expires_at` columns
   (plus a `flow_exec_lease_idx` index) to `flow_executions` to support
   lease-based claiming. Workers refuse to start until these exist; the
   startup preflight emits an actionable error pointing at this checklist.

       plumbus migrate generate
       plumbus migrate apply

2. **`AIIncompleteOutputError` is now thrown when a structured-output call
   hits `finish_reason === 'length'` / `'max_tokens'`.** Free-text prompts
   (no `responseSchema`, no `responseFormat: 'json'`) return the partial
   content as before — no behavior change. If you catch this error and
   re-issue with a higher `maxTokens`, no migration is needed.

3. **`AICostRecord` now carries `status` (default `'success'`) and an
   optional `fallbackUsed` boolean.** Reading code is unaffected. If you
   construct `AICostRecord` literals (custom tracker, test fixture), set
   `status` explicitly. The `operation` field keeps the original union —
   `'generate' | 'extract' | 'classify' | 'embed'` — so exhaustive
   `switch` statements continue to compile.

4. **New typed errors exported**: `AIValidationError`,
   `AIIncompleteOutputError`, `AIRefusalError`, `LeaseLostError`,
   `FlowCancelledError`. All extend `Error`; existing `catch` blocks are
   unaffected. The previous "AI output validation failed after N attempts"
   `Error` is now this typed subclass.

5. **Failed AI calls now count toward `dailyCostLimit`.** Sunk provider
   spend on validation-retry loops is real spend; tight ceilings may deny
   retries sooner on failure-heavy workloads. Set `dailyCostLimit` with
   headroom, or install `onAICostRecorded` to persist a ledger and tune.

6. **Default AI request timeout remains 120_000 ms.** Set
   `AIProviderConfig.requestTimeout` if your prompts need longer.

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
- `AICostRecord.status: 'success' | 'failed' | 'refused' | 'incomplete'`
  and `AICostRecord.errorMessage?: string` — new fields on cost records
  so failures are distinguishable from successes.
- `AICostRecord.fallbackUsed?: boolean` — set when the streaming call
  fell back to a non-streaming retry after the streamed output failed
  validation; both attempts are billed, so this flag is the signal for
  duplicate-billing detection.
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
- Lease-based flow claiming: workers atomically claim flow executions
  with `FOR UPDATE SKIP LOCKED`, hold a lease for the duration of the
  step, and recover crashed-worker rows via expired leases. New
  `flow_executions.lease_owner` / `lease_expires_at` columns.
- `FlowService.heartbeat()` — extends the current flow execution lease
  from inside a long-running step handler.
- `ExecutionContext.signal: AbortSignal` and `workerId: string` — set
  inside flow step execution; cooperative cancellation now flows from
  `flows.cancel()` (and lease loss) through to in-flight AI / HTTP calls.
- Lease-column preflight: `createWorkerPool().start()` probes
  `flow_executions` for the new columns and refuses to start with a
  clear migration prompt when they're missing. Also exported as
  `assertFlowLeaseColumns(db)` for direct use.

### Changed

- `costTracker.record(...)` now ALSO fires on the failure path when usage
  is known (e.g. via `AIValidationError.usage`). Previously the in-memory
  tracker only recorded successful calls, which under-counted sunk spend.
  Consumers who configured `budget.dailyCostLimit` will see failed-call
  tokens start contributing to the daily running total. Tight ceilings
  may deny retries sooner on failure-heavy workloads.
- `AIIncompleteOutputError` is thrown only when the request is in
  structured-output mode (`responseFormat: 'json'` or a `responseSchema`
  is set). Text-mode generations that hit `finish_reason === 'length'`
  return the partial content as in 0.2.x.
- `applyMigrations(config)` now returns `Promise<MigrationApplyResult>`
  (`{ applied, tags }`) instead of `Promise<void>`. Existing callers
  that ignore the return value are unaffected.

### Migration

For consumers upgrading from `0.2.x`:

1. Run `plumbus migrate generate` then `plumbus migrate apply` (mandatory —
   see Upgrade checklist item 1).
2. Existing `costTracker.record({ model, provider, usage, cost, ... })`
   calls without `status` keep compiling and default to `'success'`.
3. Existing `catch (err) { ... }` blocks reading `err.attempts`,
   `err.rawOutput`, or `err.validationMessage` from `AIValidationError`
   are unaffected — the new fields are additive.
4. Existing `ServerConfig` usages without `onAICostRecorded` are
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
