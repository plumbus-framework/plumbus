# @plumbus/chat-ui

> **React UI for [`@plumbus/chat`](../chat/).** Drop in a working AI chat surface in 5 lines — message stream, input, source citations, refusal notices, cooldowns, and confirmation slot — all wired to the framework's `ChatEvent` protocol.

[![npm](https://img.shields.io/npm/v/@plumbus/chat-ui.svg)](https://www.npmjs.com/package/@plumbus/chat-ui)
[![license](https://img.shields.io/npm/l/@plumbus/chat-ui.svg)](./LICENSE)
[![peer: @plumbus/chat ≥0.1.11](https://img.shields.io/badge/peer-%40plumbus%2Fchat%20%E2%89%A50.1.11-blue)](https://www.npmjs.com/package/@plumbus/chat)
[![peer: @plumbus/core ≥0.6.11](https://img.shields.io/badge/peer-%40plumbus%2Fcore%20%E2%89%A50.6.11-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: react ≥19](https://img.shields.io/badge/peer-react%20%E2%89%A519-61dafb)](https://react.dev)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. You declare your app's primitives (capabilities, entities, etc.) through `define*()` functions; the framework generates routes, validation, audit, and types.

[`@plumbus/chat`](../chat/) adds a **conversation primitive** — one `defineChat({...})` declaration becomes a fully-governed chat surface with policy guards, retrieval grounding, budgets, citations, and a streamed `ChatEvent` protocol.

**`@plumbus/chat-ui` is the React client for that protocol.** It consumes the event stream the server emits and renders the chat. If you're not using `@plumbus/chat`, this package has nothing to render.

## Where it fits

```
┌─ server (Plumbus app) ────────────────────────────────────────┐
│  defineChat({...})  →  registerChatRoutes(app, ...)           │
│                              │                                 │
│                              ▼                                 │
│                  POST /chat/:name/turn (SSE / JSON)            │
└──────────────────────────────┬─────────────────────────────────┘
                               │  body: { sessionId, userMessage, audience, locale, clientHistory? }
                               │  stream: ChatEvent[]
┌──────────────────────────────▼─────────────────────────────────┐
│  browser (your React app)                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ @plumbus/chat-ui                                         │  │
│  │                                                          │  │
│  │  <ChatPanel chatName audience locale sessionId .../>     │  │
│  │       └─ uses useChat()                                  │  │
│  │              └─ fetch → readChatStream → applyChatEvent  │  │
│  │                     │                                    │  │
│  │                     ▼                                    │  │
│  │              React state (ChatUiState)                   │  │
│  │              ├─ <ChatMessages />                         │  │
│  │              ├─ <ChatInput />                            │  │
│  │              ├─ <ConfirmationDialog />                   │  │
│  │              └─ <SourceCitation />                       │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

The server owns policy, retrieval, audit; the UI just renders state derived from the events.

## Status

Peer-locked to `@plumbus/chat` `0.1.x`. **`useChat.confirm()` performs the real `POST /chat/:name/confirm` round-trip** (plus `decline` and `lastConfirmResult`) — see [Key gotchas](#key-gotchas).

## Install

```bash
pnpm add @plumbus/chat-ui
```

Peers:
- `@plumbus/chat` `0.1.x` (**≥ 0.1.11** — `./protocol` subpath + Path B confirm route)
- `@plumbus/core` `0.5.x || 0.6.x` (**≥ 0.6.11** via chat 0.1.11)
- `react` `>=19` — provided transitively by [`@plumbus/ui`](../ui/) in Plumbus apps; do not add React to your own `package.json`

Prerequisites: a server-side `defineChat({...})` declaration and `registerChatRoutes(app, routeConfig, [chat])` from `@plumbus/chat`.

## Quick start

```tsx
'use client';
import { ChatPanel } from '@plumbus/chat-ui';
import { useState } from 'react';

export function HelpWidget() {
  const [sessionId] = useState(() => crypto.randomUUID());
  return (
    <ChatPanel
      chatName="help"           // must match the server-side defineChat({ name })
      sessionId={sessionId}
      audience="user"
      locale="en"
    />
  );
}
```

The panel posts to `POST /chat/help/turn` with `credentials: 'include'`, streams the assistant reply, attaches cited sources to each message, surfaces notices (cooldown, out-of-scope), and renders any `confirmation_required` event.

## What's included

| Surface | What it does |
|---|---|
| `<ChatPanel />` | High-level component: messages + input + notices + confirmation slot. The 80% case. |
| `useChat({...})` | State machine alone. Returns `{ messages, status, notices, pendingConfirmation, send, confirm, cancel }`. Drop into a custom layout. |
| `<ChatMessages />`, `<ChatInput />`, `<ConfirmationDialog />`, `<SourceCitation />` | Presentational sub-components for custom layouts. |
| `applyChatEvent(state, event)` | **Pure reducer** — `(state, ChatEvent) → state`. Testable without React or DOM. |
| `buildTurnRequestBody({...})` | Pure helper — builds the POST body, including capped `clientHistory` in client-persistence mode. |
| `pushUserMessage(state, text)`, `initialChatUiState` | More pure helpers for custom hooks. |
| `readChatStream(Response)` | Async-iterable SSE parser. Use for non-React clients or custom transports. |
| Types: `ChatUiState`, `ChatUiMessage`, `ChatUiNotice`, `ChatUiPendingConfirmation`, `ChatUiStatus`, `TurnRequestBody`, `BuildTurnBodyArgs` | The hook's shapes. |
| `useChatSession()` | **Placeholder.** Returns `useState` defaults; `sessions` never populates. Do not depend on its shape. |

## ChatPanel props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `chatName` | `string` | yes | Must match `defineChat({ name })` on the server. |
| `sessionId` | `string` | yes | Caller-generated (`crypto.randomUUID()`); persists across the conversation. |
| `audience` | `string` | yes | Threaded to the server's audience guard + prompt anchor. |
| `locale` | `string` | yes | Validated against `policy.scope.locales` if set. |
| `persistence` | `'server' \| 'client'` | no (default `'server'`) | **Must match** the server's `defineChat({ persistence: { messageContent } })`. |
| `turnUrl` | `string` | no (default `/chat/{chatName}/turn`) | Override when routes are namespaced (e.g. `/api/chat/help/turn`). |
| `className` | `string` | no | Applied to the wrapper div. |

## Key gotchas

- **`persistence` must match the server.** `<ChatPanel persistence="client" />` ships the last 20 messages on every turn; `'server'` ships nothing. Mismatching values still runs but breaks context (server-mode client + client-mode server = model sees no history).
- **`useChat.confirm()` performs the server round-trip.** It POSTs to `confirmUrl` (default `/chat/{chatName}/confirm`); the server authenticates like `/turn`, executes the confirmed capability/flow through the framework pipeline, and resumes the turn. `decline(actionId)` posts a reject; the terminal outcome lands in `lastConfirmResult` and a `confirmation.resolved` event. Cookie-authenticated apps must be served from the server's configured origin (exact-Origin + CSRF enforced server-side).
- **Cookie auth only.** `useChat` and `<ChatPanel />` hard-code `credentials: 'include'`. Bearer-auth flows need a small fork (~80 lines — see [`instructions/custom-ui.md`](./instructions/custom-ui.md)).
- **`useChatSession` is a placeholder.** Kept on the barrel so a real multi-session API can land later without a breaking export change.
- **No `/testing` subpath.** The pure helpers (`applyChatEvent`, `buildTurnRequestBody`, `pushUserMessage`) are testable with vitest directly — no jsdom needed.

## Documentation

- **Concepts and reference** (in the monorepo): [`docs/chat-ui/README.md`](../../docs/chat-ui/README.md) — wiring diagram, full event vocabulary, persistence pairing matrix, prop tables, headless usage, action-confirmation rationale.
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/chat-ui/instructions/`):
  - [`instructions/framework.md`](./instructions/framework.md) — package boundary (React-only), public exports, file map, critical rules
  - [`instructions/wiring-chat-panel.md`](./instructions/wiring-chat-panel.md) — default `<ChatPanel />` recipe, persistence pairing, `turnUrl`
  - [`instructions/custom-ui.md`](./instructions/custom-ui.md) — headless `useChat`, pure helpers, `readChatStream`, bearer-auth fork
  - [`instructions/action-confirmation.md`](./instructions/action-confirmation.md) — confirmation round-trip (`confirm` / `decline`) and Path B tool confirmation

## The Plumbus ecosystem

`@plumbus/chat-ui` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Server-side runtime** — [`@plumbus/chat`](../chat/) (required peer)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
