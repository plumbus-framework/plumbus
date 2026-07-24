# @plumbus/chat-ui — Framework

React hooks and components that consume the `@plumbus/chat` turn protocol — SSE by default, JSON request/response when the server-side `defineChat({ streaming: false })`.

The package is intentionally thin: a state-managing hook, a high-level panel component, presentational sub-components, and pure helpers you can fold into custom UIs.

## Package boundary

| Concern | Owned by |
|---|---|
| `defineChat`, runtime, policy guards, context sources | `@plumbus/chat` (server-side) |
| `registerChatRoutes` (HTTP endpoint registration) | `@plumbus/chat` |
| SSE event protocol (`ChatEvent` union) | `@plumbus/chat` — re-used here |
| `<ChatPanel />` and sub-components | `@plumbus/chat-ui` |
| `useChat` hook + pure helpers | `@plumbus/chat-ui` |
| SSE client parser | `@plumbus/chat-ui` (`readChatStream`) |

`@plumbus/chat-ui` peer-depends on `@plumbus/chat` (`0.1.x`), `@plumbus/core` (`0.5.x || 0.6.x`), and `react` (`>=19`). In Plumbus apps React comes through `@plumbus/ui` — do not add it to your own `package.json`.

**`package.json` peer (framework releases):** `"@plumbus/core": "0.5.x || 0.6.x"` — copy from `packages/mcp/package.json`; see `packages/plumbus-core/instructions/peer-dependencies.md`.

## Public exports

```ts
// from '@plumbus/chat-ui'
useChat({ chatName, sessionId, audience, locale, persistence?, turnUrl?, confirmUrl? })
                                                  // → { messages, status, notices, pendingConfirmation, lastConfirmResult, send, confirm, decline, cancel }

ChatPanel                                          // pre-wired: messages + notices + input + confirmation dialog
ChatMessages                                       // just the message list with cited sources
ChatInput                                          // just the textarea + send button
ConfirmationDialog                                 // renders pendingConfirmation; Confirm / Cancel callbacks
SourceCitation                                     // single cited-source pill

// Pure helpers (use for custom UIs / non-React consumers)
applyChatEvent(state, event)                       // pure reducer (state, ChatEvent) → state
buildTurnRequestBody({ sessionId, userMessage, audience, locale, persistence?, currentMessages })
pushUserMessage(state, text)
initialChatUiState
readChatStream(Response)                           // async-iterable SSE parser

// State shapes
ChatUiState, ChatUiMessage, ChatUiNotice, ChatUiStatus, ChatUiPendingConfirmation
BuildTurnBodyArgs, TurnRequestBody

useChatSession()                                   // PLACEHOLDER — returns local useState defaults; do not depend on the shape
```

## File map (`src/`)

```
src/
├── index.ts                          # public barrel
├── hooks/
│   ├── useChat.ts                    # state machine — fetch + applyChatEvent loop
│   ├── useChat-helpers.ts            # pure helpers (applyChatEvent, buildTurnRequestBody, ...)
│   └── useChatSession.ts             # placeholder
├── components/
│   ├── ChatPanel.tsx                 # high-level component
│   ├── ChatMessages.tsx
│   ├── ChatInput.tsx
│   ├── ConfirmationDialog.tsx
│   └── SourceCitation.tsx
└── client/
    └── event-stream.ts               # readChatStream (SSE parser)
```

## Critical rules

1. **Cookie auth only.** `useChat` and `<ChatPanel />` POST with `credentials: 'include'`. For Bearer-auth flows, copy the hook and swap the `fetch` call — do not add a `headers` option to the helper (out of scope).
   - **CSRF.** The hook reads the `CHAT_CSRF_COOKIE_NAME` (`plumbus_chat_csrf`) cookie and echoes it in the `CHAT_CSRF_HEADER_NAME` (`x-plumbus-chat-csrf`) header on every turn/confirm POST — both are exported from `@plumbus/chat`. A hand-rolled cookie-auth fetch UI must send this header too or the server rejects the write (Bearer requests are CSRF-exempt).
2. **`persistence` must match the server.** The `<ChatPanel persistence="client" />` prop tells the panel to ship `clientHistory` on every turn. If the server-side chat was defined with `persistence: { messageContent: 'server' }`, the panel still ships history that the server ignores (wasted bytes). If the server is `'client'` and the panel says `'server'`, the model loses conversational context. See wiring-chat-panel.md.
3. **`confirm()` / `decline()` perform a real server round-trip.** `confirm(actionId?)` and `decline(actionId?)` POST to `confirmUrl ?? /chat/${chatName}/confirm` (`credentials: 'include'`, CSRF header set) with `{ actionId, inputSchemaHash, decision }`. The server executes the confirmed capability/flow through the full pipeline from the stored normalized input (never a client-supplied name or input), then resumes the turn for a final answer — clearing `pendingConfirmation` and setting `lastConfirmResult`. `cancel()` is a local-only dismiss (`status → 'idle'`, no network). See action-confirmation.md.
4. **`useChatSession` is a placeholder.** It returns local `useState` defaults — `sessions` never populates. Kept on the barrel so a real multi-session API can land later without a breaking export change. Do not depend on its shape.
5. **No subpath exports.** Everything imports from `@plumbus/chat-ui`. There is no `/testing` subpath (chat-ui has no test helpers of its own — use vitest jsdom and exercise the pure helpers directly).

## Where to look for more

Conceptual reference and the wiring diagram: `docs/chat-ui/README.md` in the Plumbus monorepo. Chat server-side: `docs/chat/` and `node_modules/@plumbus/chat/instructions/`.
