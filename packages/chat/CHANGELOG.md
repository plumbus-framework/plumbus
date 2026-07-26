# Changelog

## Unreleased

### Added

- **New `@plumbus/chat/protocol` subpath.** `CHAT_CSRF_COOKIE_NAME` and `CHAT_CSRF_HEADER_NAME` now live in a dependency-free, browser-safe module and are re-exported unchanged from the package root, so existing server-side imports keep working. **Browser code must import them from `@plumbus/chat/protocol`**: reaching them through the package root pulls in `runtime/csrf.ts` (`node:crypto`) and, via `@plumbus/core`, the whole CLI including drizzle-kit and esbuild — a graph strict bundlers such as Turbopack refuse to resolve for a client component. `@plumbus/chat-ui`'s `useChat` was switched to the subpath; hand-rolled clients should do the same.
- **Injectable session storage (`runChatTurn(ctx, args, { sessionStore })`).** Chat persistence is now a two-tier contract. Tier 1, the new `ChatSessionStore`, covers session bootstrap, turn append/read, behavioral state, summaries, and budget rollups; tier 2 is the existing lease-based `ChatConversationStore` for tool confirmations. Supplying a tier-1 store lets a deployment with no local database run the stock turn pipeline against its own memory backend instead of maintaining a fork of it. Every method takes `ctx` first so an adapter can reach an app-owned port. See [`docs/chat/session-store.md`](../../docs/chat/session-store.md).
- **`sessionStore` option on the entry points** — `RegisterChatRoutesOpts.sessionStore`, `createChatTurnCapability(chat, opts)`, `runChatEvaluation(..., { stores })`, and `mockChatRuntime(..., options, stores)`. Guards receive the store as `GuardState.sessionStore`; custom guards should resolve it with `resolveChatSessionStore(state.sessionStore)` rather than reading `ctx.data`. When `registerChatRoutes` is given a `sessionStore` and no `store`, the C5 pre-turn live-pending probe is skipped: a tier-1-only deployment cannot hold pending actions, and the probe would otherwise read `ctx.data`.
- **`createInMemoryChatSessionStore`** (`@plumbus/chat/testing`) — a Map-backed tier-1 store that never touches `ctx.data`, usable as both a test double and a reference implementation. It covers the whole required surface plus `aggregateForBudget` and `createSession`; it omits `countActivePendingActions`, which is meaningless without tier 2.
- **New exports.** From the root barrel: `ChatSessionStore`, `RunChatTurnOpts`, `ChatBudgetAggregate`, `ChatBudgetAggregateQuery`, `ChatBudgetAggregator`, `CreateChatSessionArgs`, `GetOrCreateChatSessionArgs` (types); `dbChatSessionStore`, `resolveChatSessionStore`, `requireChatBudgetAggregator`, `assertChatSessionStoreSupportsBudget`, `assertChatStoresSupportChats`, `ChatStoreUnsupportedError` (values). From `@plumbus/chat/testing`: `createInMemoryChatSessionStore`.
- **Startup validation via `assertChatStoresSupportChats`,** applied by `registerChatRoutes` to every registered chat. It is a no-op unless a `sessionStore` is injected, and throws `ChatStoreUnsupportedError` when a chat declares a `budget` the store cannot aggregate (`chat.budget_unsupported`), caps pending actions the store cannot count (`chat.budget_unsupported`), or can raise confirmations with no `conversationStore` supplied (`chat.storage_unsupported`). The same conditions also fail closed at turn time.
- **New error code `chat.budget_unsupported`** — an injected store cannot aggregate the stored turns needed to enforce a configured `budget`. Raised instead of silently leaving a cap unenforced. This is about cap **enforcement** only: AI cost recording (`costContext`, the cost tracker, `onAICostRecorded`) lives in `@plumbus/core`'s AI service, reads nothing from `ChatSession`/`ChatTurn`, and is unaffected by an injected store. Unreachable unless a `sessionStore` is injected.

### Changed

- `actionGuard` counts pending actions through `ChatSessionStore.countActivePendingActions` instead of reaching `ctx.data` directly. The DB-backed default preserves the previous behavior exactly, including lazy expiry of lapsed rows.
- `chat.storage_unsupported` gains a second trigger. It already fired when a store adapter lacked a conditional-write path; it is now also raised when a chat that can request confirmations runs on an injected `sessionStore` with no `conversationStore`. The original trigger is unchanged.
- Internal signatures widened with an optional store parameter: `checkBudgetPreflight`, `maybeSummarize`, `loadHistoryWindow`. None are exported from the package barrel or `/testing`.

### Requires

- Nothing new. Peer ranges are unchanged (`@plumbus/core` stays `0.5.x || 0.6.x`, `@plumbus/knowledge-base` stays `^0.1.0`), so this does not affect npm installs in backend Docker builds.

### Breaking

- **None.** Every new parameter is optional and every behavior change is gated on `opts.sessionStore` being supplied, which no existing caller does — so applications that inject nothing take byte-for-byte the previous code path. `GuardState` gained an optional `sessionStore` field, which is source-compatible for consumer-authored guards. No entity, schema, event, or HTTP wire-shape change.

### Migration

- None required. To adopt the seam, implement `ChatSessionStore` and pass it as `runChatTurn(ctx, args, { sessionStore })` or `registerChatRoutes(..., { sessionStore })`.

## 0.1.11 — 2026-07-24 — provider-native tool calling

### Added

- **Path B — provider-native tool calling (`policy.toolCalling`).** Capabilities and `autoStartFlows` are bound as provider-native tools; a bounded per-turn loop (`maxToolRounds` default 5, range 1..20) drives the provider through tool rounds using the registered `chat.toolRound` prompt. Chat does **not** call core's `runToolLoop`. Auto-mode tools execute inline via `ctx.__runtime.resolveCapability` + `executeCapability` (access policy enforced); confirm-mode tools pause the turn with `confirmation_required` and execute on confirm. `autoStartFlows` tools additionally run under a bounded per-turn flow budget so a single turn cannot start an unbounded number of flows.
- **`POST /chat/:name/confirm` — always framework-invoke + resume.** Confirm-mode tool calls (Path B) are always executed through the framework capability pipeline on confirm, then the tool loop is resumed from a durable `resumePayload` to produce the final answer. Confirm reuses `/turn` authentication via `ChatRequestAuthenticator`; cookie-authenticated writes additionally require exact-Origin + a session-bound CSRF token.
- **New events** — `tool.started`, `tool.completed`, `tool.failed`, and `confirmation.resolved`. `confirmation_required` keeps its underscore discriminator (wire compat) and gains optional `inputSchemaHash` and a validated `projection`. `pendingStatus` includes `expired`.
- **Lease-based `ChatConversationStore`** — `acquireSessionMutation` / `commitProposal` / `claimPending` / `completePending` make propose and confirm+resume atomic; `ChatTurn` uses a unique `(sessionId, ordinal)` index. Adapters without a conditional/transactional write path fail closed with `chat.storage_unsupported`, raised the first time a turn or confirm needs a conditional write (`createChatConversationStore` probes the repository), not at process start.
- **Durable `ChatPendingActionV2`** — stores only the **normalized** input (resolved contract, `argumentsStatus 'parsed'`, Zod-validated, defaults/coercions applied); confirm never re-reads input from the client. Invalid arguments produce no pending row — one safe `chat.tool_arguments_invalid` observation instead.
- **Binding hash** — `toolBindingHash` (with `targetVersion` from `CapabilityContract.version` or the input-schema-hash fallback; flow `targetVersion` is the flow input-schema hash) is re-verified at confirm time; drift fails with `chat.binding_changed`. Flow tools use the reserved `flow__` prefix and portable grammar (flow names ≤ 57 chars).
- **Existing-pending rule** — `/turn` checks the live pending action before scope/provider work: `pending` → `chat.pending_action_exists`; `confirming` → `chat.session_busy`; expired pending is atomically terminalized then the turn proceeds. `409` body is `{ code, actionId, expiresAt }`.

### Changed

- **Path A `frameworkExecuteOnConfirm` (accepted but RESERVED — not yet enforced).** `policy.action` accepts `frameworkExecuteOnConfirm`, but it is **reserved and not enforced in this release** — no code path reads it. Path A confirm remains **decision-only** regardless of its value: validate, mark confirmed, emit events, no side effects (unchanged historical behavior). Whether a confirm performs framework execution is gated by the request's `execute` flag, not this field. The knob is reserved so a future release can enable framework execution without a schema break.

### Requires

- **Prompt re-export.** Re-export `chatToolRoundPrompt` (`chat.toolRound`) and `chatScopeCheckPrompt` (`chat.scopeCheck`) from `@plumbus/chat` into `app/prompts/` so directory discovery registers them (same one-time wiring as `chat.turn`). Path B fails at startup with `chat.prompt_not_registered` if either is absent. The `createChatRegistry` used to enforce this prompt-registration check is wired at `registerChatRoutes`, so the check runs during route registration.
- Core with the provider tool protocol, `runToolLoop`, `EntityIndexDefinition.unique`, and the conditional/transactional repository write path (see `@plumbus/core` changelog). Peer range unchanged (`0.5.x || 0.6.x`).

### Breaking

- **`chatConfirmAction` input/output shape changed.** Input is now `{ actionId, chatName, decision: 'confirm' | 'reject', inputSchemaHash, toolBindingHash, execute }` and output is `{ decisionRecorded, pendingStatus, executionStatus, events }`. The prior 0.1.10 input `{ actionId, schemaHash, execute }` / output `{ executed }` is **superseded**. Real-world impact is minimal — the prior 0.1.10 handler was a non-executing stub with no shipped caller — but the wire shape did change, so any code constructing the old input or reading `executed` must migrate.

### Migration

- **Run migrations.** Existing persisted-chat apps must run:

  ```bash
  plumbus migrate generate && plumbus migrate apply
  ```

  The schema change is **additive**: the new `chat_pending_action` columns (`input_schema_hash`, `tool_binding_hash`) are `NOT NULL DEFAULT ''`, the legacy `schema_hash` column is **retained**, and a new `UNIQUE` index is added on `chat_turn (session_id, ordinal)`. No backfill is needed. The unique index can fail to create if a pre-existing high-concurrency `chat_turn` table already holds duplicate `(session_id, ordinal)` rows — dedupe those rows first, then re-apply.

## 0.1.10

### Breaking behavior changes

Documented knobs enforce when set — no soft/legacy dual mode. See [Migration stance](../../docs/upgrading-contract-alignment.md#migration-stance-locked).

- **C7 — Budget enforcement:** `perTurn` tokens/cost, DB-backed `perSession.userMessages`, `actions.perSession`, and `provenance.minSources` are enforced. Ephemeral `userMessages` cap unchanged. Unset knobs remain unlimited.
- **C10 — Audience auto-filter:** When `policy.audience` is set, `ragContext` without `filter` applies `{ audience }` retrieve metadata (opt out: `parentChatAudiencePolicy: false`).

### Behavior fixes

- **C6 — Action-confirm schema hash v2:** Pending actions store `v2:` + sha256 of capability input schema via `ctx.capabilities.describe`; confirm rejects schema drift (`chat.action_schema_changed`). Legacy unprefixed hashes keep echo-compare. Invalid propose-time input is blocked (`chat.action_input_invalid`). `chatConfirmAction` validates and updates status but does not execute the target capability; decline is idempotent for missing/already-rejected/expired rows and emits `chat.action.rejected` only when a row is newly rejected (no forged/duplicate events). Ownership is checked before hash/expiry mutations. `chat.action.confirmed` / `chat.action.rejected` events are declared on the capability; `chatActionRejectedEvent` is exported for consumers.
- **C8 — Behavioral cooldowns:** `windowSeconds`, `guardFailure`, and `budget` triggers honored; user-scoped keys merge across recent sessions (`*:user:*` only — fresher cross-session user keys override stale local copies; session-scoped cooldowns from other sessions do not bleed).
- **C9 — `policy.reply.locale`:** Threaded into `buildSystemPrompt` (`auto` vs forced locale anchor).
- **C11 — Custom prompt base-field warning:** `defineChat` warns at define-time when a custom prompt output omits required chat base fields.
- **C12 — Context source timeout:** Per-source timeout (default 5s, overridable via `contextResolution.perSourceTimeoutMs`) skips slow sources with a `ctx.logger.warn` when `onError: 'skip'`.
- **Pre-turn guard cooldowns:** Pre-turn block paths record behavioral cooldown triggers before ending the turn (except `cooldown_active` itself, which does not re-extend the lockout).
- **Action-guard describe fallback:** When `ctx.capabilities.describe` is unavailable, propose uses a legacy payload hash and emits a console warning.
- **`ChatPendingActionRepo.findMany`:** Required when `budget.actions.perSession` is set (custom repo implementers must provide it).

### Notes (core AI security)

Chat turns call `ctx.ai.generate*` on the same AI service as capabilities. AI prompt security activates only when the app configures `aiProviders.security` or `AI_SECURITY_*` env vars — there is no automatic scanning without that config.

## 0.1.9

### Changed

- Peer dependency `@plumbus/core` corrected to `0.5.x || 0.6.x` so npm accepts `@plumbus/core` **0.6.x** (`^0.5.0 <0.7.0` only matched 0.5.x under npm semver).

## 0.1.8

### Changed

- Peer dependency `@plumbus/core` widened to `^0.5.0 <0.7.0` so chat installs alongside `@plumbus/core` **0.6.x** (voice/media cost ledger release).

## 0.1.7

### Changed

- Peer dependency `@plumbus/core` updated to `^0.5.0 <0.6.0` for the **0.5.0** release (workers/queues, canonical capability names, flow auth snapshot).

## 0.1.6

### Documentation

- README ecosystem table lists `@plumbus/api` (partner external API add-on).

## 0.1.4 — 2026-05-26

- `TurnContext.contextTokenBudget` and `TurnContext.userMessage` stamped in `run-turn.ts` before context resolution (registry-backed knowledge scope packing and RAG query plumbing).
- **Breaking:** direct-RAG helper renamed to `ragContext` (was `knowledgeContext({ corpus, query })`).
- New registry-backed `knowledgeContext({ registry, source, scopeFromTurn?, queryFromTurn?, tier? })` — optional peer on `@plumbus/knowledge-base@^0.1.0`.
- Deprecated `knowledgeContextLegacy` alias (= `ragContext`) for one minor; removal in v0.2.
- `knowledgeContext({ tier: 'tools' })` throws `knowledge.chat_tier_not_supported` at construction (tier 2 not executed in v0.1.4).
- `staticContextFromTranslations` marked `@deprecated`; use `translationCatalog` + registry-backed `knowledgeContext`.

| Package | Version | Relationship |
|---|---:|---|
| `@plumbus/knowledge-base` | `0.1.0` | New optional package |
| `@plumbus/chat` | `0.1.4` | Adds registry-backed `knowledgeContext` |
| `@plumbus/core` | `^0.4.0 <0.5.0` | Required peer of KB |

## 0.1.3 — 2026-05-25

- `runChatTurn` auto-creates the `chat_session` row when `loadSession` returns null AND `saveToDb: true`. Lets consumers ship client-generated session UUIDs without a separate bootstrap capability (`chatStart`). Identity (`userId`, `tenantId`, `audience`, `locale`, `chatName`) comes from `ctx.auth` + the request. **Breaking semantic** (no API break): the `chat.session_not_found` event no longer fires under normal operation — only on `loadSession` errors. Consumers that relied on the failure signal should switch to checking `getOrCreateSession` directly.
- New export: `getOrCreateSession(ctx, args)` — idempotent session bootstrap with caller-supplied id. Handles primary-key race (concurrent first-turns) via try/re-load. Use directly if you want explicit control vs. letting `runChatTurn` do it for you.

## 0.1.2 — 2026-05-25

- `defineChat({ persistence: { saveToDb?: boolean } })` — opt out of all server-side DB writes for ephemeral chat surfaces (in-product help widgets, public marketing chats). When `saveToDb: false`, the runtime skips `loadSession`, `aggregateTurnCount`, `checkBudgetPreflight`, `maybeSummarize`, and both `appendTurn` calls. Session is synthesized from the request; client owns sessionId generation. Cost recording via `onAICostRecorded` is unchanged. Default remains `true` (fully backward compatible — flipping back to `true` resumes writing to the existing chat tables).
- `saveToDb: false` enforces `messageContent: 'client'` and rejects `policy.action.allowedCapabilities` at `defineChat` validation (no chat_turn row to hold content; no chat_pending_action row to survive across requests).
- `clientHistory` wire shape extended: each message now carries an optional `refusalReason` field. Lets the server-side behavioral cooldown guard enforce policy from the client-supplied history when there's no `chat_session.behavioral_state` to read from. Backward compatible (the field is optional).
- `behavioralPreGuard` branches on `saveToDb`: reads DB state when true; reads `clientHistory` when false. Refusal cooldown semantics in ephemeral mode: "last N assistant messages are all refusals → block + emit `chat.cooldown_active` notice with `retryAfterSeconds`."
- `behavioralPostGuard` is a no-op when `saveToDb: false` (nothing to persist — next turn's clientHistory re-supplies the state).
- `budget.perSession.userMessages` works in ephemeral mode by counting user-role messages in `clientHistory + 1`. Per-tenant / per-user / per-day budgets still require `saveToDb: true`.
- `GuardState` gained `saveToDb?: boolean` and `clientHistory?` fields so custom guards can branch on persistence mode and read the wire history.

## 0.1.1 — 2026-05-19

- `defineChat({ streaming?: boolean })` — opt-in JSON `{ events }` responses when `streaming: false`.
- `turn.completed` events include optional `inScope`, `refusalReason`, and `sources`.
- `registerChatRoutes` opts: `authCookieNames`, `audienceTenantOverride` (auth spread), `beforeTurn`, `afterTurn`.
- Turn body schema uses `.passthrough()` for consumer fields (`projectId`, `currentPath`).

## Unreleased — v0.2 features (preview, NOT shipped)

The following landed in source ahead of the v0.2 gate but are not part of v0.1
and have not been tagged. They live in the package because they were built as
part of one Phase but the gate is real: per the implementation plan, a real
consumer (e.g. a production help-bot migration) must stress v0.1 in production
before v0.2 ships, so the eval scenarios are informed by actual failures rather
than synthetic guesses. Treat the surface below as unstable until v0.2 is
tagged.

- Evaluation framework: `defineChatEvaluation`, `runChatEvaluation`,
  `TraceRecorder`, three reference evals exercising audience filter,
  scope-classifier refusal, and action confirmation.
- Observability events: `chat.turn.completed`, `chat.action.confirmed`,
  `chat.refusal.recorded` (emitted via `defineEvent`).
- Package instructions under `instructions/`.

## 0.1.0 — 2026-05-19

Initial release. v0.1 ships the runtime needed to replace any per-app one-off
chat surface end-to-end.

### Added

- `defineChat({ instructions, context, policy, budget, history, persistence,
  exposeAs, prompt? })` — declarative chat configuration with Zod validation.
- Context sources: `knowledgeContext` (wraps `ctx.ai.retrieve` against a
  registered RAG corpus), `capabilityContext` (calls a read capability per
  turn, rejects write-effect capabilities at construction time),
  `staticContext` (inline structured items), `staticContextFromTranslations`
  (built from i18n catalogs so prompt labels don't drift from translations).
- Policy guards: `audience`, `locale`, `behavioral` cooldowns,
  `scope-classifier` (single-call structured-output), `privacy.redact`,
  `provenance` (validates citations against runtime-issued handles),
  `action` (capability-backed write with `requireConfirmation`).
- Budgets: per-turn, per-session, per-user, per-tenant, context-tokens, action
  count, per-turn timeout.
- Session entities: `ChatSession`, `ChatTurn`, `ChatPendingAction`. Per-session
  message-content persistence is opt-out via
  `persistence: { messageContent: 'client' }` (Decision 0009).
- `runChatTurn` orchestrator emitting a typed event stream: `turn.started`,
  `source.added`, `notice`, `message.delta`, `confirmation_required`,
  `turn.completed`, `turn.failed`. Stream falls back to non-streaming
  `generateWithUsage` only when the provider never delivers a validated `done`
  payload — refusals (`inScope: false`, empty `answer`) do not double-charge.
- Capabilities: `chatTurn`, `chatConfirmAction`, `chatListTurns`.
- Generic `chat.turn` prompt with structured output (`inScope`, `answer`,
  `refusalReason`, `citedSources`, `requestedAction`). Per-chat prompt
  overrides via `defineChat({ prompt })` (Decision 0008).
- Client-history wire protocol for `client` persistence chats: turn body
  carries `clientHistory: Array<{role, content}>`, capped server-side at 20
  messages × 4000 chars with a 400 + `chat.client_history_too_large` rejection
  (Task 7.4b).
- Provenance: model never invents source IDs; runtime issues handles
  (`src_a`, `src_b`, ...), validates citations on output, persists only the
  cited subset on `ChatTurnRow.sources`.

### Dependencies

- Requires `@plumbus/core ^0.4.0 <0.5.0`. Zod is imported from
  `@plumbus/core/zod` (not a direct dep).
- Core change landed before this release: `ctx.ai.retrieve({ corpus?, query,
  filter?, ... })` (Decision 0010).
