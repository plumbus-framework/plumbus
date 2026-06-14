# @plumbus/chat

> **Policy-first conversation runtime for [Plumbus](https://github.com/plumbus-framework/plumbus) apps.** Declare a chat, plug in context sources, set guards — get a fully-governed AI conversation with cited sources, budgets, refusals, and an event-streamed UI.

[![npm](https://img.shields.io/npm/v/@plumbus/chat.svg)](https://www.npmjs.com/package/@plumbus/chat)
[![license](https://img.shields.io/npm/l/@plumbus/chat.svg)](./LICENSE)
[![peer: @plumbus/core ^0.5](https://img.shields.io/badge/peer-%40plumbus%2Fcore%20%5E0.5-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. You declare capabilities, entities, events, flows, prompts, and translations through `define*()` functions; the framework generates routes, validation, audit, security, and types.

`@plumbus/chat` adds a **conversation primitive** on top of that contract — one `defineChat({...})` declaration becomes a complete chat surface with:

- Audience-scoped retrieval grounding (RAG, capability-backed lookups, translation-backed surfaces, static facts)
- Seven built-in policy guards (audience, locale, scope, privacy, provenance, action, behavioral)
- Per-turn / per-session / per-user / per-tenant budgets, with cost recording
- Action-confirmation flow with schema-hash re-validation
- A streamed `ChatEvent` protocol consumed by `<ChatPanel />` in [`@plumbus/chat-ui`](../chat-ui/)

If you're not using Plumbus, this package won't make sense in isolation — `defineChat` composes on the framework's `ExecutionContext`, capability registry, prompt registry, and audit pipeline.

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| A single capability call with no conversational state | `defineCapability` in `@plumbus/core` |
| A long-running multi-step workflow | `defineFlow` in `@plumbus/core` |
| One-shot RAG-grounded answer with no chat surface | `ctx.ai.retrieve` + a normal capability |
| **Multi-turn user conversation with scope, budgets, citations, and an event stream** | **`@plumbus/chat`** (this package) |
| Just expose a capability to an AI agent | [`@plumbus/mcp`](../mcp/) |
| React UI for your `defineChat` chat | [`@plumbus/chat-ui`](../chat-ui/) |

## Status

Peer-locked to `@plumbus/core` `^0.5.0 <0.6.0`. The surface is implemented end-to-end: the `defineChat` declaration, policy DSL, context-source contract, streamed event protocol, `mockChatRuntime` testing helper, the deterministic evaluation harness (`defineChatEvaluation` / `runChatEvaluation` / `TraceRecorder`), and the runtime's domain events.

## Install

```bash
pnpm add @plumbus/chat
```

Required peer: `@plumbus/core` `^0.5.0 <0.6.0`. The framework provides Zod, Vitest, Playwright, and Drizzle transitively — do not add them to your own `package.json`.

For the React UI, also install [`@plumbus/chat-ui`](../chat-ui/). For registry-backed knowledge sources, [`@plumbus/knowledge-base`](../knowledge-base/).

## Quick start

```ts
import { defineChat, knowledgeContext, registerChatRoutes } from '@plumbus/chat';
import { onRoutesRegistered } from '@plumbus/core';

export const helpChat = defineChat({
  name: 'help',
  access: { roles: ['user'] },
  context: [
    knowledgeContext({
      corpus: 'product-docs',
      query: (turnCtx) => turnCtx.userMessage,
      filter: (turnCtx) => ({ audience: turnCtx.audience, locale: turnCtx.locale }),
    }),
  ],
  policy: {
    audience: { roles: ['user', 'admin'], mode: 'strict' },
    reply: { locale: 'auto' },
    scope: { description: 'Help with ProductX only.' },
    behavioral: { cooldowns: [{ trigger: 'refusal', count: 3, durationSeconds: 30, scope: 'session' }] },
  },
  budget: { perSession: { userMessages: 35 }, perTurn: { tokens: 6000 } },
  exposeAs: 'sse',
});

// Register the chat entities so migrations pick them up:
import { chatSessionEntity, chatTurnEntity, chatPendingActionEntity } from '@plumbus/chat';
export const entities = [/* your entities */, chatSessionEntity, chatTurnEntity, chatPendingActionEntity];

// Mount the HTTP route (POST /chat/help/turn — SSE by default):
onRoutesRegistered((app, routeConfig) => {
  registerChatRoutes(app, routeConfig, [helpChat]);
});
```

That's a fully-governed chat: roles enforced, retrieval cached and cited, off-scope messages refused, budget exhaustion guarded, refusal cooldowns tracked. Pair with `<ChatPanel chatName="help" ... />` from `@plumbus/chat-ui` on the client.

## What's included

| Surface | What it does |
|---|---|
| `defineChat({...})` | The declarative entrypoint. Validated with Zod, deep-frozen. |
| `runChatTurn(ctx, args)` | Streaming runtime — yields `ChatEvent`s. Composable in custom transports. |
| `registerChatRoutes(app, routeConfig, chats, opts?)` | Mount one SSE/JSON route per chat. Opts: `authCookieNames`, `audienceTenantOverride`, `beforeTurn`, `afterTurn`. |
| `knowledgeContext`, `capabilityContext`, `staticContext`, `staticContextFromTranslations` | Built-in context sources. |
| `chatSessionEntity`, `chatTurnEntity`, `chatPendingActionEntity` | Entities — register in the app entity list. |
| `chatTurnPrompt`, `chatSummarizeHistoryPrompt`, `buildSystemPrompt`, `renderContext` | Prompt building blocks. Override per-chat via `definePrompt`. |
| `compilePolicy(policy)` | Returns the ordered guard list — for advanced custom runtimes. |
| `chatConfirmAction`, `chatListTurns`, `createChatTurnCapability` | Auto-routed capabilities. |
| `validateCitations`, `stripInvalidFromAnswer` | Provenance helpers. |
| `mockChatRuntime` (from `@plumbus/chat/testing`) | Drop-in test harness — runs the full pipeline with a mocked AI. |
| `defineChatEvaluation`, `runChatEvaluation`, `TraceRecorder` | Deterministic eval harness — script a model, run scenarios, assert on the event stream and trace. See [`docs/chat/evaluations.md`](../../docs/chat/evaluations.md). |

## Key gotchas

- **Register the three chat entities.** Without `chatSessionEntity`, `chatTurnEntity`, `chatPendingActionEntity` in your app entity list, migrations won't create the underlying tables and the runtime will fail at first turn.
- **`exposeAs` defaults to `'sse'`** — the SSE route is the only one mounted. Set `exposeAs: 'capability'` for server-to-server clients that can't consume an event stream, or `'both'` to mount both (rare).
- **`persistence.saveToDb: false` requires `messageContent: 'client'`.** And it rejects `policy.action.allowedCapabilities` — ephemeral chats can't survive the action-confirmation round-trip. `defineChat` validates this at startup.
- **`policy.scope.classifier: 'inline'`** — the model classifies and answers in one call (Decision 0001). Refusal turns spend generation tokens; empirically cheaper than a preflight LLM call.
- **`useChat.confirm()` in `@plumbus/chat-ui` only clears local state.** The server-side `chatConfirmAction` capability does the real schema-hash re-validation; clients must call it directly. See [chat-ui docs](../chat-ui/) and [`docs/chat/policies.md`](../../docs/chat/policies.md).

## Documentation

- **Concept docs** (in the monorepo): [`docs/chat/`](../../docs/chat/)
  - [`README.md`](../../docs/chat/README.md) — when to use, architecture, package layout
  - [`defining-chats.md`](../../docs/chat/defining-chats.md) — full `defineChat` config + `registerChatRoutes` opts
  - [`policies.md`](../../docs/chat/policies.md) — the seven built-in guards
  - [`context-sources.md`](../../docs/chat/context-sources.md) — context-source contract + every built-in
  - [`testing.md`](../../docs/chat/testing.md) — `mockChatRuntime` + helpers
  - [`evaluations.md`](../../docs/chat/evaluations.md) — eval scenarios with `defineChatEvaluation` / `runChatEvaluation`
  - [`design/`](../../docs/chat/design/) — 10 design decisions explaining the framework's shape
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/chat/instructions/`):
  - [`instructions/framework.md`](./instructions/framework.md) — file map, package conventions, critical rules
  - [`instructions/defining-chats.md`](./instructions/defining-chats.md) — recipe for adding a chat
  - [`instructions/policies.md`](./instructions/policies.md) — guard configuration recipes
  - [`instructions/context-sources.md`](./instructions/context-sources.md) — picker + per-helper recipes
  - [`instructions/testing.md`](./instructions/testing.md) — test patterns
  - [`instructions/extending.md`](./instructions/extending.md) — custom prompts, context sources, guards

## The Plumbus ecosystem

| Package | Purpose | When to install |
|---|---|---|
| [`@plumbus/core`](../plumbus-core/) | Foundation — capabilities, entities, events, flows, prompts, translations, runtime, CLI, audit, governance. | Always (required). |
| [`@plumbus/ui`](../ui/) | Next.js/React UI — typed API clients, auth helpers, form metadata, scaffolds. | When building a Plumbus web UI. |
| [`@plumbus/api`](../api/) | Partner external API — manifest, OpenAPI, docs, compatibility diff, test intent. | Optional peer `0.1.x` — when publishing a documented partner-facing HTTP API. |
| [`@plumbus/mcp`](../mcp/) | MCP runtime — serve capabilities to AI agents (`tools/*`, `tasks/*`, transports). | Optional peer `0.5.x` — when exposing capabilities to MCP clients. |
| **`@plumbus/chat`** | **You are here.** Conversational runtime — `defineChat`, policy guards, context sources, streamed events. | Optional peer `0.1.x` — when adding a chat surface. |
| [`@plumbus/chat-ui`](../chat-ui/) | React chat UI — hooks and `<ChatPanel />` for the `@plumbus/chat` turn protocol. | Peer of `@plumbus/chat` — when adding a browser chat client. |
| [`@plumbus/knowledge-base`](../knowledge-base/) | Knowledge providers — scoped sources, registry, chat `knowledgeContext` integration. | Optional peer of `@plumbus/chat` `0.1.x` — when sharing named knowledge across features. |
| [`@plumbus/browser-extension`](../browser-extension/) | Extension scaffolder — WXT Chrome/Firefox project wired to your capabilities. | With `@plumbus/ui` (`0.1.x`) — when shipping a browser extension UI. |

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## Testing

```bash
pnpm test
```

For consumer-app tests, import `mockChatRuntime` from `@plumbus/chat/testing` with `createTestContext` and `mockAI` from `@plumbus/core/testing`. See [`docs/chat/testing.md`](../../docs/chat/testing.md).

## License

MIT
