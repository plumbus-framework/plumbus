# Chat UI (`@plumbus/chat-ui`)

React hooks and components that consume the `@plumbus/chat` turn protocol — SSE by default, JSON request/response when the chat is defined with `streaming: false`.

The package is intentionally thin: a state-managing hook, a high-level panel component, a small library of presentational sub-components, and pure helpers you can fold into your own UI.

## Glossary

A few terms appear repeatedly. Pinning them down up front:

- **Turn** — one user message and everything the server emits in response (deltas, source attributions, optional confirmation, completion). One POST to `/chat/:name/turn` produces exactly one turn's worth of events.
- **Anchor** — a short, server-injected line in the system prompt that pins audience or locale for the model (e.g. `[Reply in 'en' only.]`, `[Audience: admin.]`). The hook never sees it; it's baked in before the model call.
- **Audience** — the caller's role bucket as the chat understands it (e.g. `'user'`, `'admin'`). Threaded all the way from `<ChatPanel audience=…>` through the request body to context-source filters and the prompt anchor.
- **Persistence mode** — server policy declared on the chat: whether message *prose* lives in the DB (`messageContent`) and whether the chat tables get written at all (`saveToDb`). Documented server-side in [defining-chats.md](../chat/defining-chats.md#persistence-mode-decision-0009); the UI side has to be told to match (see "Persistence pairing" below).

## How the pieces fit together

```
┌─ server (Node) ──────────────────────────────────────────────────────────┐
│                                                                          │
│   defineChat({ name, access, policy, context, persistence, … })          │
│             │                                                            │
│             ▼                                                            │
│   registerChatRoutes(app, routeConfig, [chat])                           │
│             │                                                            │
│             ▼                                                            │
│   POST /chat/:name/turn   (SSE by default; JSON if streaming: false)     │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │  body: { sessionId, userMessage, audience,    │
                           │          locale, clientHistory? }             │
                           │  stream: ChatEvent[]                          │
┌──────────────────────────▼───────────────────────────────────────────────┐
│ browser                                                                  │
│                                                                          │
│   <ChatPanel chatName audience locale sessionId persistence? turnUrl? /> │
│             │                                                            │
│             ▼                                                            │
│   useChat({ … })                                                         │
│       fetch → readChatStream → applyChatEvent → React state              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The server owns chat definition and policy; the wire format is `ChatEvent[]`; the browser only renders state derived from those events. There is no second protocol — `<ChatPanel />` and a custom UI built on `readChatStream` consume the same stream.

## Prerequisites

- A Plumbus app with a server-side chat defined via `defineChat` and exposed over HTTP via `registerChatRoutes` (see [defining-chats.md](../chat/defining-chats.md)). The default turn URL is `POST /chat/:name/turn`.
- React 19. In Plumbus apps both React and React DOM come transitively through `@plumbus/ui`; do not add them to your own `package.json`.

## Install

`@plumbus/chat-ui` ships under the same major as `@plumbus/chat`:

```
pnpm add @plumbus/chat-ui
```

Peers: `@plumbus/chat` `^0.1.0 <0.2.0`, `react` / `react-dom` `^19`.

## Minimal usage

```tsx
'use client';
import { ChatPanel } from '@plumbus/chat-ui';
import { useState } from 'react';

export function HelpButton() {
  const [sessionId] = useState(() => crypto.randomUUID());
  return (
    <ChatPanel
      chatName="help"
      sessionId={sessionId}
      audience="user"
      locale="en"
    />
  );
}
```

By default the panel POSTs to `/chat/help/turn` with `credentials: 'include'` (cookie auth) and renders the streamed assistant reply incrementally.

## Surface map

| Symbol | Kind | Purpose |
|---|---|---|
| `ChatPanel` | component | Pre-wired panel: messages, notices, input, confirmation dialog. Use this when you don't need a custom layout. |
| `ChatMessages` | component | Just the message list. Renders cited sources via `SourceCitation`. |
| `ChatInput` | component | Just the textarea + send button, disables itself while a turn is in-flight. |
| `ConfirmationDialog` | component | Renders the model's `confirmationMessage` and exposes Confirm / Cancel callbacks. |
| `SourceCitation` | component | A single cited source pill. |
| `useChat` | hook | The state machine. Exposes `messages`, `status`, `notices`, `pendingConfirmation`, `send`, `confirm`, `cancel`. |
| `useChatSession` | hook | **Placeholder in v0.1** — returns local `useState` defaults. Stub kept on the barrel so future API can land without a breaking export change. Do not depend on its shape. |
| `applyChatEvent` | helper | Pure reducer: `(state, ChatEvent) → state`. Use this to roll your own hook. |
| `buildTurnRequestBody` | helper | Pure: builds the POST body, including capped `clientHistory` for `persistence: 'client'`. |
| `pushUserMessage`, `initialChatUiState` | helpers | Building blocks for custom hooks. |
| `readChatStream` | helper | `(Response) → AsyncIterable<ChatEvent>` SSE parser. Use directly if you're writing a non-React client. |
| `ChatUiState`, `ChatUiMessage`, `ChatUiNotice`, `ChatUiPendingConfirmation`, `ChatUiStatus`, `TurnRequestBody`, `BuildTurnBodyArgs` | types | The hook's shapes. |

## The `ChatEvent` vocabulary

A turn produces a sequence of `ChatEvent`s — the same `ChatEvent` union exported from `@plumbus/chat`. `useChat` folds them into state via `applyChatEvent`; a custom UI built on `readChatStream` consumes them directly.

| `type` | Carries | What it means |
|---|---|---|
| `turn.started` | `turnId`, `ordinal` | The server accepted the request and is about to call the model. Flip your UI into a "streaming" state. |
| `message.delta` | `text` | A chunk of assistant prose to append to the current assistant bubble. Multiple per turn. |
| `source.added` | `source: { id, origin, label? }` | A retrieved context source the model is using. Attach to the in-progress assistant message for citation rendering. |
| `notice` | `code`, `message`, `retryAfterSeconds?` | A non-fatal advisory: cooldown active, out of scope, provenance missing, etc. Render alongside the message stream; `chat.cooldown_active` flips the hook into `'cooldown'` status. |
| `confirmation_required` | `actionId`, `capabilityName`, `confirmationMessage`, `expiresAt`, `schemaHash` | The post-turn `action-guard` paused the turn awaiting user approval. Render the confirmation dialog; the client supplies `{ actionId, schemaHash, capabilityName, execute }` to the `chatConfirmAction` capability to commit or reject. |
| `turn.completed` | `turnId`, `usage`, `cost`, `inScope?`, `refusalReason?`, `sources?` | Terminal success event. Hook flips status back to `'idle'`. |
| `turn.failed` | `code`, `message` | Terminal failure event (`chat.not_found`, budget exhaustion, etc.). Hook flips to `'error'`. |

Exactly one of `turn.completed` or `turn.failed` (or `confirmation_required` followed by an out-of-band confirm) ends every turn. The hook's `status` field tracks the lifecycle so app code rarely needs to inspect events directly — but if you're writing a custom renderer, this is the full set.

## `<ChatPanel />`

| Prop | Type | Required | Notes |
|---|---|---|---|
| `chatName` | `string` | yes | Must match a chat registered with `registerChatRoutes`. |
| `sessionId` | `string` | yes | Caller generates (e.g. `crypto.randomUUID()`); persists across the conversation. For chats with `persistence.saveToDb: false`, this is the only handle the server has. |
| `audience` | `string` | yes | Threaded to the server's audience guard and prompt anchor. |
| `locale` | `string` | yes | BCP-47-ish. The server's locale guard validates against `policy.scope.locales` if set. |
| `persistence` | `'server' \| 'client'` | no (default `'server'`) | When `'client'`, the panel ships the last 20 messages on every request via `clientHistory` — must match the chat's `persistence.messageContent`. |
| `turnUrl` | `string` | no (default `/chat/{chatName}/turn`) | Override when your app namespaces routes under a prefix (e.g. `/api/chat/help/turn`). |
| `className` | `string` | no | Applied to the outer wrapper div. |

`ChatPanel` always uses `credentials: 'include'` — cookie auth Just Works; bearer-auth callers need a custom panel.

## `useChat(args)`

Same arg shape as `<ChatPanel />` minus `className`. Returns:

```ts
{
  messages: ChatUiMessage[];
  status: 'idle' | 'streaming' | 'awaiting_confirmation' | 'cooldown' | 'error';
  notices: ChatUiNotice[];
  pendingConfirmation: ChatUiPendingConfirmation | null;
  send: (text: string, extras?: { sessionId?: string; locale?: string; extraBody?: Record<string, unknown> }) => Promise<void>;
  confirm: (actionId: string) => Promise<void>;
  cancel: () => void;
}
```

- `send(text, extras?)` POSTs a turn. Detects `Content-Type` on the response: `application/json` payloads are unmarshalled as `{ events: ChatEvent[] }`; anything else is read via `readChatStream`. The `extras.extraBody` map is merged into the POST body — use it to forward app-specific fields when `beforeTurn` on `registerChatRoutes` reads them.
- `confirm(actionId)` is currently a UI-only stub (clears `pendingConfirmation` and sets status back to `idle`). It does **not** call the server-side `chatConfirmAction` capability. If you need action confirmation in v0.1, read `pendingConfirmation` off the hook (it carries `actionId`, `capabilityName`, and `schemaHash` from the `confirmation_required` event) and call `chatConfirmAction` directly via the auto-routed `POST /api/chat/chat-confirm-action` endpoint with `{ actionId, capabilityName, schemaHash, execute: true }`. A first-party round-trip is planned for v0.2.
- `cancel()` resets `status` to `'idle'` without server interaction.

## Persistence pairing

`persistence` is a server-defined policy ([defining-chats.md](../chat/defining-chats.md#persistence-mode-decision-0009)); the UI side has to be told to match. Mismatching values is the most common configuration footgun.

| Server (`defineChat`) | Client (`<ChatPanel persistence=… />` / `useChat`) | Wire effect | When to use |
|---|---|---|---|
| `persistence: { messageContent: 'server' }` (default) | `persistence="server"` (default) | `clientHistory` omitted; server reads turns from DB. | Audit trail, cross-device continuity. |
| `persistence: { messageContent: 'client' }` | `persistence="client"` | Last 20 messages shipped as `clientHistory` on every turn. | Privacy-sensitive chats — message prose never lands in your DB. |
| `persistence: { messageContent: 'client', saveToDb: false }` | `persistence="client"` | Same as above. Server keeps no `chat_session` row at all; cooldowns / per-session limits are enforced from `clientHistory`. | In-product help widgets where DB durability is overkill. |
| `persistence: { messageContent: 'server', saveToDb: false }` | — | **Invalid** — rejected at `defineChat` time. | — |

If the client persistence value doesn't match the server's `messageContent`, the chat will still run but behave badly: `'server'` client on a `'client'` chat sends no history (model loses context); `'client'` client on a `'server'` chat ships history the server ignores (wasted bytes).

Apps that opt into `saveToDb: false` cannot use action confirmation — there's no `chat_pending_action` row to hold state across the propose/confirm round-trip. `defineChat` rejects this combination at startup.

The `ChatEvent` types come from `@plumbus/chat` and are reused as-is — no separate UI event vocabulary.

## Headless usage

If you want the state machine without `<ChatPanel />`'s markup, drop `useChat` into your own component. If you want zero React, compose `readChatStream` with the pure helpers:

```ts
import { readChatStream } from '@plumbus/chat-ui';
import { applyChatEvent, initialChatUiState, buildTurnRequestBody } from '@plumbus/chat-ui';

let state = initialChatUiState;
const res = await fetch('/chat/help/turn', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify(buildTurnRequestBody({ /* … */ })),
});
for await (const evt of readChatStream(res)) {
  state = applyChatEvent(state, evt);
}
```

The pure helpers are the same ones `useChat` uses internally — test them directly with Vitest (see [chat/testing.md](../chat/testing.md)).

## What's not here

- **Action confirmation round-trip.** `confirm()` is a UI-only stub in v0.1 (see above).
- **Multi-session management.** `useChatSession` is a placeholder; build your own list/picker on top of `useChat` if you need it.
- **Bearer-token transport.** `useChat` and `<ChatPanel />` always send `credentials: 'include'`. For bearer-auth flows, copy the hook and swap the `fetch` call.
- **A non-React client.** `readChatStream` is framework-agnostic; the rest of the package is React-only.

## File map

| Concern | File |
|---|---|
| `useChat` hook | [`packages/chat-ui/src/hooks/useChat.ts`](../../packages/chat-ui/src/hooks/useChat.ts) |
| Pure helpers | [`packages/chat-ui/src/hooks/useChat-helpers.ts`](../../packages/chat-ui/src/hooks/useChat-helpers.ts) |
| Placeholder session hook | [`packages/chat-ui/src/hooks/useChatSession.ts`](../../packages/chat-ui/src/hooks/useChatSession.ts) |
| SSE parser | [`packages/chat-ui/src/client/event-stream.ts`](../../packages/chat-ui/src/client/event-stream.ts) |
| `<ChatPanel />` and sub-components | [`packages/chat-ui/src/components/`](../../packages/chat-ui/src/components/) |
