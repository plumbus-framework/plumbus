# Changelog

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
consumer (e.g. MemoirAI's help-bot migration) must stress v0.1 in production
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
