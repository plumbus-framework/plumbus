# Chat (`@plumbus/chat`)

The Plumbus framework's chat primitive. Turns a declarative `defineChat({...})` config into a fully-governed conversation runtime: context resolution, scope and provenance guards, per-turn and per-session budgets, refusal cooldowns, action confirmation, and a typed event stream for the UI.

The runtime lives in [`packages/chat`](../../packages/chat). The thin React layer lives in [`packages/chat-ui`](../../packages/chat-ui).

These docs are split in three:

- **Usage** (the files in this folder) — how to define, configure, test, and ship a chat. Human-readable, explanatory.
- **[Design](./design/)** — *why* the framework is shaped the way it is. Tradeoffs, rejected alternatives, locked decisions. Read before you "fix" something that looks weird.
- **Agent instructions** — prescriptive "do this / don't do that" guidance for AI coding agents. Lives at [`packages/chat/instructions/`](../../packages/chat/instructions/) and ships in the npm tarball so agents working in `node_modules/@plumbus/chat/` can find it. The instructions cross-link back to these docs for the deeper conceptual material.

## Usage docs

| Doc | Read when… |
|---|---|
| [defining-chats.md](./defining-chats.md) | You want to author a new `defineChat` config or wire `registerChatRoutes`. |
| [policies.md](./policies.md) | You need to understand the seven built-in guards and the order they fire in. |
| [context-sources.md](./context-sources.md) | You're wiring up `ragContext`, registry `knowledgeContext`, `capabilityContext`, or `staticContext`. |
| [testing.md](./testing.md) | You're writing tests with `mockChatRuntime` or the pure UI helpers. |
| [evaluations.md](./evaluations.md) | You're writing eval scenarios for a chat with `defineChatEvaluation` / `runChatEvaluation`. |
| [tool-calling.md](./tool-calling.md) | You're enabling `policy.toolCalling` so the model calls capabilities directly (Path B). |
| [confirmation-persistence.md](./confirmation-persistence.md) | You're migrating chat entities or wiring durable confirmation + session revision CAS. |
| [session-store.md](./session-store.md) | Your deployment has no local database and needs chat memory served from a remote platform or port. |
| [../chat-ui/README.md](../chat-ui/README.md) | You're wiring `<ChatPanel />`, `useChat`, or the SSE client helpers in a React app. |

## Design docs

See [design/](./design/) for the eleven decision records — why the framework is shaped the way it is, what alternatives were rejected, and what to watch out for when extending it.

## Agent instructions

Read these when you're an AI agent extending a Plumbus app that uses chat. They live in the package itself ([`packages/chat/instructions/`](../../packages/chat/instructions/)) so they're available in `node_modules/@plumbus/chat/instructions/` for agents working outside this monorepo:

- [`instructions/framework.md`](../../packages/chat/instructions/framework.md) — file map, package conventions, critical rules
- [`instructions/defining-chats.md`](../../packages/chat/instructions/defining-chats.md) — recipe for adding a chat
- [`instructions/policies.md`](../../packages/chat/instructions/policies.md) — recipe for configuring guards
- [`instructions/context-sources.md`](../../packages/chat/instructions/context-sources.md) — picker + recipes for each helper
- [`instructions/testing.md`](../../packages/chat/instructions/testing.md) — test patterns
- [`instructions/extending.md`](../../packages/chat/instructions/extending.md) — custom prompts, context sources, guards

## When to reach for `@plumbus/chat` vs. something else

| You want… | Reach for |
|---|---|
| A single capability call with no conversational state | `defineCapability` in `@plumbus/core` |
| A long-running multi-step workflow | `defineFlow` in `@plumbus/core` |
| One-shot RAG-grounded answer with no chat surface | `ctx.ai.retrieve` + a normal capability |
| **Multi-turn user conversation with scope, budgets, citations, and an event stream** | **`@plumbus/chat`** |
| Conversational *agent* with autonomous tool selection | **`@plumbus/chat`** with `policy.toolCalling` (Path B) — the model calls capabilities/flows as provider-native tools over a bounded loop; auto-mode tools execute inline, confirm-mode tools pause with `confirmation_required` and resume after `POST /chat/:name/confirm`. See [policies.md](./policies.md#tool-calling-path-b) and [design/tool-calling.md](./design/tool-calling.md). |

Use chat when the surface itself is the product: a help bot, customer support, in-product Q&A. If the AI work is upstream of a capability and the user never sees a chat, you don't need this package.

## Architecture in one paragraph

A chat is declared once via `defineChat`. Each user turn runs through a fixed pipeline: budget preflight → pre-turn guards (audience, locale, behavioral) → eager context resolution → prompt build with structured-output scope guard baked in → model call (streaming or fallback) → post-turn guards (provenance, scope, privacy, action, behavioral) → session persistence → event emission. The runtime never lets the model invent source IDs, never lets a write-effect capability appear as a context source, and never sends a turn that would breach configured limits. Pipeline state lives in `ChatSession` + `ChatTurn` entities; conversation prose lives there by default but can be opted out of (`persistence.messageContent: 'client'`).

## Package layout

```
packages/chat/
  src/
    index.ts                          Public barrel
    define/
      defineChat.ts                   The declarative entrypoint
      defineChatEvaluation.ts         Declares eval scenarios (see evaluations.md)
    context/
      knowledge-context.ts            Registry-backed @plumbus/knowledge-base adapter
      rag-context.ts                  Direct ctx.ai.retrieve over a registered RAG corpus
      capability-context.ts           Wraps a read capability (write-effect capabilities rejected)
      static-context.ts               Inline structured items (path maps, glossaries)
      static-context-from-translations.ts   Deprecated — use translationCatalog + knowledgeContext
      resolver.ts                     Eager parallel resolution with stable handles
    policy/
      registry.ts                     compilePolicy(policy) → preTurn[] + postTurn[]
      audience-guard.ts               Strict-mode role check
      locale-guard.ts                 Locale normalization + whitelist
      scope-classifier.ts             Single-call structured-output refusal
      privacy-guard.ts                Substring redaction (current limitation — not regex/structured PII)
      provenance-guard.ts             Validates citations against runtime handles
      action-guard.ts                 Capability re-validation; pending-action store
      behavioral-guard.ts             Cooldown state read/increment
    budget/, history/, runtime/, session/, capabilities/, prompt/
    eval/                             runChatEvaluation + TraceRecorder (see evaluations.md)
    testing/                          mockChatRuntime helper
    events/                           Domain events (chat.turn.completed, etc.)
    internal/                         Private helpers
packages/chat-ui/
  src/
    hooks/useChat.ts                  + pure helpers (applyChatEvent, buildTurnRequestBody)
    client/event-stream.ts            SSE parser
    components/                       ChatPanel, ChatMessages, ChatInput, ConfirmationDialog, SourceCitation
```

## Relationship to `@plumbus/core`

This package composes on core; it does not duplicate. Specifically:

| Concern | Owned by | Used here as |
|---|---|---|
| LLM calls (`generate`, `streamGenerate`, `generateWithUsage`) | core | direct dependency in `run-turn.ts` |
| RAG retrieval (`ctx.ai.retrieve({ corpus, query, filter })`) | core | wrapped by `ragContext` (direct) or registry `knowledgeContext` |
| Capability execution | core | wrapped by `capabilityContext` (read-only) and `action-guard` (write with confirmation) |
| Auth / tenant scoping | core | inherited via `ExecutionContext` |
| Cost ledger / `onAICostRecorded` hook | core | every chat AI call tags `costContext.serviceArea = 'chat'`, `operationName = chat.<name>` |
| Entity registry / Drizzle migrations | core | chat entities register through the same path as any consumer entity |
| Prompts (`definePrompt`) | core | the generic `chat.turn` prompt is a normal Plumbus prompt; per-chat overrides plug into `AiConfig` admin overrides like every other prompt |

## What the package provides

- `defineChat` with full policy DSL (audience, scope, reply, privacy, provenance, behavioral, action, custom guards).
- Three built-in context sources + a translation-backed helper.
- All five budget scopes (`perTurn`, `perSession`, `perUser`, `perTenant`, `contextTokens`) plus `actions.perSession` and per-turn timeout are enforced when configured.
- Streaming runtime with a typed event protocol.
- Pending-action confirmation with v2 schema-hash re-validation (`v2:` + capability input schema via `ctx.capabilities.describe`).
- Provider-native tool calling (`policy.toolCalling`, Path B): capabilities + `autoStartFlows` bound as provider tools, a bounded per-turn tool loop, durable `ChatPendingActionV2`, and a `POST /chat/:name/confirm` route that executes through the capability pipeline and resumes the turn for an answer-only completion (no further tool rounds). Emits `tool.started` / `tool.completed` / `tool.failed` / `confirmation.resolved` events.
- React hook (`useChat`) and components in `@plumbus/chat-ui`.
- Session and turn persistence with opt-out for message content.
- Domain events (`chatTurnCompletedEvent`, `chatActionConfirmedEvent`, `chatRefusalRecordedEvent`) emitted by the runtime.
- A deterministic evaluation harness (`defineChatEvaluation`, `runChatEvaluation`, `TraceRecorder`) — see [evaluations.md](./evaluations.md).

## Public barrel: what each export is for

`@plumbus/chat` exports more than the headline `defineChat` + `runChatTurn`. The full surface, grouped:

| Group | Exports | Notes |
|---|---|---|
| Definition | `defineChat`, `defineChatEvaluation` | `defineChat` is the entrypoint; `defineChatEvaluation` declares eval scenarios |
| Runtime | `runChatTurn`, `registerChatRoutes`, `RegisterChatRoutesOpts` | |
| Policy | `compilePolicy` | public for advanced tooling; chats normally compile policies internally |
| Context helpers | `ragContext`, `knowledgeContext`, `knowledgeContextLegacy` (deprecated alias for `ragContext`), `capabilityContext`, `staticContext`, `staticContextFromTranslations` (deprecated), `resolveContextSources`, `CHAT_TIER_TOOLS_ERROR_PREFIX` | `resolveContextSources` is advanced — for custom runtimes |
| Prompts | `chatTurnPrompt`, `chatSummarizeHistoryPrompt`, `buildSystemPrompt`, `renderContext` | overridable via `definePrompt` + AI Config admin |
| Capabilities | `createChatTurnCapability`, `chatConfirmAction`, `chatListTurns` | auto-routed; `chatConfirmAction` is what a client calls to commit a pending action |
| Entities | `chatSessionEntity`, `chatTurnEntity`, `chatPendingActionEntity` | register in your app's entity list |
| Session service | `createSession`, `loadSession`, `appendTurn`, `aggregateForBudget`, `updateSessionBehavioralState`, `updateSessionSummary` | advanced — for custom turn pipelines / migrations; most apps never need these |
| Session storage | `ChatSessionStore`, `RunChatTurnOpts`, `dbChatSessionStore`, `resolveChatSessionStore`, `assertChatStoresSupportChats`, `ChatStoreUnsupportedError` | inject non-DB chat persistence — see [session-store.md](./session-store.md) |
| Runtime utilities | `ChatEventEmitter`, `validateCitations`, `stripInvalidFromAnswer`, `setTokenCounter` | advanced — only reach for these when wrapping the runtime or swapping the token counter (e.g. local tiktoken vs heuristic) |
| Evaluation | `runChatEvaluation`, `TraceRecorder` | run scenarios against a scripted model and assert on the event stream — see [evaluations.md](./evaluations.md) |
| Events | `chatTurnCompletedEvent`, `chatActionConfirmedEvent`, `chatRefusalRecordedEvent` | domain events emitted by the runtime; subscribe with an `eventHandler` capability |
