# Recipe: Wire `<ChatPanel />`

The default path. Use this when the consumer wants a working chat surface and doesn't need custom layout / styling beyond a `className`.

## Prerequisites

- A `defineChat({...})` declaration on the server (see `node_modules/@plumbus/chat/instructions/defining-chats.md`).
- `registerChatRoutes(app, routeConfig, [chat])` wired in `app/server.ts` (or wherever the app registers routes).
- Cookie-based auth — the panel posts with `credentials: 'include'`. For Bearer-only flows, see custom-ui.md.

## 1. Install

```bash
pnpm add @plumbus/chat-ui
```

Peers: `@plumbus/chat` `0.1.x`, `@plumbus/core` `0.5.x || 0.6.x`, `react` `>=19` (provided by `@plumbus/ui` in Plumbus apps).

## 2. Mount the panel

```tsx
'use client';
import { ChatPanel } from '@plumbus/chat-ui';
import { useState } from 'react';

export function HelpWidget() {
  const [sessionId] = useState(() => crypto.randomUUID());
  return (
    <ChatPanel
      chatName="help"        // must match the server-side defineChat({ name })
      sessionId={sessionId}
      audience="user"
      locale="en"
    />
  );
}
```

That's it. The panel renders messages, notices, an input, and a confirmation dialog (the dialog is currently a stub — see action-confirmation.md if the chat declares `actions`).

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `chatName` | `string` | yes | Must match a chat registered with `registerChatRoutes`. |
| `sessionId` | `string` | yes | Caller generates (e.g. `crypto.randomUUID()`); persists across the conversation. |
| `audience` | `string` | yes | Threaded to the server's audience guard and prompt anchor. |
| `locale` | `string` | yes | BCP-47-ish. Server's locale guard validates against `policy.scope.locales` if set. |
| `persistence` | `'server' \| 'client'` | no (default `'server'`) | **MUST match the server's `defineChat({ persistence: { messageContent } })`.** |
| `turnUrl` | `string` | no (default `/chat/{chatName}/turn`) | Override when the route is namespaced (e.g. `/api/chat/help/turn`). |
| `className` | `string` | no | Applied to the outer wrapper div. |

## sessionId — when to generate it

- **Per-mount (most common):** `useState(() => crypto.randomUUID())` — a new session per component instance. Refresh = new session.
- **Per-user persistent:** store in `localStorage` so the same user sees their history across refreshes. Only useful when the server runs with `persistence: { messageContent: 'server' }` and you want cross-device continuity through the same session.
- **Server-minted:** call a `startChat` capability that returns the session ID. Optional — chat works without it because `getOrCreateSession` inserts on the first turn.

## Persistence pairing

| Server `defineChat({ persistence })` | Panel prop | Wire effect |
|---|---|---|
| `{ messageContent: 'server' }` (default) | `persistence="server"` (default) | `clientHistory` omitted; server reads turns from DB. Best for audit + cross-device continuity. |
| `{ messageContent: 'client' }` | `persistence="client"` | Last 20 messages shipped as `clientHistory` on every turn. Best for privacy-sensitive surfaces. |
| `{ messageContent: 'client', saveToDb: false }` | `persistence="client"` | Same; server keeps no `chat_session` row at all. In-product help widgets where DB durability is overkill. |
| `{ messageContent: 'server', saveToDb: false }` | — | **Invalid** — rejected at `defineChat` time. |

If panel and server disagree:
- `persistence="server"` panel + `'client'` server → model sees no history (each turn looks like a first turn).
- `persistence="client"` panel + `'server'` server → wasted bytes; server ignores `clientHistory`.

## turnUrl — when to override

Plumbus default is `POST /chat/:name/turn`. Override `turnUrl` when:
- The app namespaces routes under a prefix (`/api/...`).
- A reverse proxy / Next.js rewrite forwards `/api/chat/...` to the Plumbus server.
- You wrap `registerChatRoutes` in a middleware that changes the path.

```tsx
<ChatPanel chatName="help" sessionId={s} audience="user" locale="en" turnUrl="/api/chat/help/turn" />
```

## What runs on the server per turn

The hook POSTs `{ sessionId, userMessage, audience, locale, clientHistory? }` to `turnUrl`. The server runs the standard chat turn pipeline (budget preflight → pre-turn guards → context resolution → model call → post-turn guards → persistence → events). The response is an SSE stream of `ChatEvent`s or `Content-Type: application/json` with `{ events: ChatEvent[] }` when `defineChat({ streaming: false })`.

The hook detects content type and folds events into state via `applyChatEvent`. The panel renders from the resulting `ChatUiState`.

## Don'ts

- **Don't pass random strings for `audience` / `locale`.** They're validated by `audience-guard` and `locale-guard` on the server. The chat's `policy.audience.roles` and `policy.scope.locales` are the source of truth.
- **Don't change `sessionId` mid-conversation.** A new sessionId is a new conversation — the server treats it as the first turn. Use `useState(() => crypto.randomUUID())` so the ID is stable across re-renders.
- **Don't import sub-components individually if you can use `<ChatPanel />`.** The panel wires them together correctly. Reach for `<ChatMessages />` / `<ChatInput />` / `<ConfirmationDialog />` only when building a custom layout — see custom-ui.md.

## See also

- Custom UIs (when ChatPanel isn't enough): [custom-ui.md](./custom-ui.md)
- Action confirmation: [action-confirmation.md](./action-confirmation.md)
- Server-side chat: `node_modules/@plumbus/chat/instructions/defining-chats.md`
