# Changelog

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
