# Recipe: Custom chat UI

When `<ChatPanel />` is not enough — custom layout, custom message rendering, embedded inside a larger interface, non-React clients — use `useChat` headless or compose the pure helpers directly.

## Option 1: `useChat` headless (React, custom layout)

```tsx
'use client';
import { useChat } from '@plumbus/chat-ui';

export function MyChat({ sessionId }: { sessionId: string }) {
  const chat = useChat({
    chatName: 'help',
    sessionId,
    audience: 'user',
    locale: 'en',
    // persistence: 'client',   // optional — must match server
    // turnUrl: '/api/chat/help/turn',  // optional override
  });

  return (
    <div>
      {chat.notices.map((n) => (
        <div key={n.code} role="status">{n.message}</div>
      ))}
      {chat.messages.map((m, i) => (
        <div key={`${m.role}-${i}`}>{m.content}</div>
      ))}
      <input
        disabled={chat.status === 'streaming'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void chat.send(e.currentTarget.value);
        }}
      />
    </div>
  );
}
```

### `useChat` return shape

```ts
{
  messages: ChatUiMessage[];                       // { role, content, sources?, inScope?, refusalReason? }
  status: 'idle' | 'streaming' | 'awaiting_confirmation' | 'cooldown' | 'error';
  notices: ChatUiNotice[];                         // { code, message, retryAfterSeconds? }
  pendingConfirmation: ChatUiPendingConfirmation | null;
                                                    // { actionId, capabilityName, confirmationMessage, expiresAt, inputSchemaHash?, projection? }
  lastConfirmResult: ChatUiConfirmResult | null;   // { actionId, decision, pendingStatus, executionStatus }
  send: (text: string, extras?: { sessionId?, locale?, extraBody? }) => Promise<void>;
  confirm: (actionId?: string) => Promise<void>;   // real server round-trip — POSTs the confirm decision, then resumes the turn
  decline: (actionId?: string) => Promise<void>;   // real server round-trip — POSTs the reject decision
  cancel: () => void;                              // local dismiss only — no server call
}
```

- `send(text, extras?)` POSTs a turn. `extras.extraBody` is merged into the request body — use to forward app-specific fields when `registerChatRoutes.beforeTurn` reads them.
- `confirm(actionId?)` / `decline(actionId?)` POST the decision to `confirmUrl ?? /chat/{chatName}/confirm` — a real server round-trip. On `confirm` the server executes the stored, normalized action through the full pipeline (deny-by-default access preserved) and resumes the turn for a single final answer; both echo the pending `inputSchemaHash` and populate `lastConfirmResult`. `actionId` defaults to `pendingConfirmation.actionId`.
- `cancel()` resets `status` to `'idle'` without server interaction (local dismiss only — it does **not** resolve the pending action server-side; use `decline` for that).

## Option 2: Headless without React

For a non-React client, compose `readChatStream` with the pure helpers.

```ts
import { CHAT_CSRF_COOKIE_NAME, CHAT_CSRF_HEADER_NAME } from '@plumbus/chat';
import { applyChatEvent, buildTurnRequestBody, initialChatUiState, readChatStream } from '@plumbus/chat-ui';

let state = initialChatUiState;

// Cookie-auth writes require the CSRF header (see the CSRF note below): read the
// cookie the server set and echo it back. Do the same on the /confirm POST.
const csrf = document.cookie
  .split(';')
  .map((c) => c.trim())
  .find((c) => c.startsWith(`${CHAT_CSRF_COOKIE_NAME}=`))
  ?.slice(CHAT_CSRF_COOKIE_NAME.length + 1);
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (csrf) headers[CHAT_CSRF_HEADER_NAME] = decodeURIComponent(csrf);

const res = await fetch('/chat/help/turn', {
  method: 'POST',
  headers,
  credentials: 'include',
  body: JSON.stringify(buildTurnRequestBody({
    sessionId: 'sess-1',
    userMessage: text,
    audience: 'user',
    locale: 'en',
    persistence: 'server',                          // or 'client'
    currentMessages: state.messages,
  })),
});

if (res.headers.get('content-type')?.startsWith('application/json')) {
  const { events } = await res.json() as { events: ChatEvent[] };
  for (const evt of events) state = applyChatEvent(state, evt);
} else {
  for await (const evt of readChatStream(res)) {
    state = applyChatEvent(state, evt);
  }
}
```

These helpers are pure — they're testable with vitest and have no React or DOM dependency.

### CSRF on hand-rolled fetches

The server enforces an exact-`Origin` + session-bound CSRF check on **every cookie-authenticated write** to `/chat/:name/turn` and `/chat/:name/confirm` (`enforceBrowserWrite`). `useChat` and `<ChatPanel />` handle this for you; any hand-rolled fetch that authenticates by cookie — the Option 2 client above — **must** read the `CHAT_CSRF_COOKIE_NAME` cookie (`plumbus_chat_csrf`) and echo it in the `CHAT_CSRF_HEADER_NAME` header (`x-plumbus-chat-csrf`) on **both** the turn and confirm POSTs, or the server rejects the write. Both constants are exported from `@plumbus/chat`. Only requests that authenticate with an `Authorization: Bearer` header and no cookie are CSRF-exempt.

## Option 3: Reuse the sub-components with custom wrapping

```tsx
import { ChatMessages, ChatInput, ConfirmationDialog, useChat } from '@plumbus/chat-ui';

export function MyChat({ sessionId }: { sessionId: string }) {
  const chat = useChat({ chatName: 'help', sessionId, audience: 'user', locale: 'en' });
  return (
    <div className="my-custom-layout">
      <header>{/* your branding */}</header>
      <ChatMessages messages={chat.messages} />
      <ConfirmationDialog
        pendingConfirmation={chat.pendingConfirmation}
        onConfirm={() => chat.confirm(chat.pendingConfirmation?.actionId ?? '')}
        onReject={() => chat.decline(chat.pendingConfirmation?.actionId ?? '')}
      />
      <ChatInput pending={chat.status === 'streaming'} onSend={(t) => void chat.send(t)} />
    </div>
  );
}
```

Useful when the consumer wants the same UX as `<ChatPanel />` but with a custom header/footer or layout.

## ChatEvent vocabulary (what `applyChatEvent` consumes)

`useChat` folds these events into state. The same `ChatEvent` union is exported from `@plumbus/chat`.

| `type` | Carries | What `applyChatEvent` does |
|---|---|---|
| `turn.started` | `turnId`, `ordinal` | sets `status = 'streaming'`. |
| `message.delta` | `text` | appends to the in-progress assistant message (or starts a new one). |
| `source.added` | `source: { id, origin, label? }` | attaches a citation source ID (deduped) to the assistant message. |
| `notice` | `code`, `message`, `retryAfterSeconds?` | pushes into `notices`. `chat.cooldown_active` flips `status` to `'cooldown'`. |
| `confirmation_required` | `actionId`, `capabilityName`, `confirmationMessage`, `expiresAt`, `inputSchemaHash?`, `projection?` | sets `pendingConfirmation`; flips `status` to `'awaiting_confirmation'`. |
| `turn.completed` | `turnId`, `usage`, `cost`, `inScope?`, `refusalReason?`, `sources?` | tags the last assistant message with refusal metadata; flips `status` to `'idle'`. |
| `turn.failed` | `code`, `message` | flips `status` to `'error'`. |
| `tool.started` | `toolCallId`, `name`, `kind` | recognized; folds to **no** state change (no tool message bubble). |
| `tool.completed` | `toolCallId`, `name`, `kind`, `projection?` | pushes a `chat.tool_completed` notice. `projection` is validated ≤8 KiB — **never** raw capability/flow results. |
| `tool.failed` | `toolCallId`, `name`, `kind`, `code`, `message` | pushes a notice carrying the tool's `code` / `message`. |
| `confirmation.resolved` | `actionId`, `decision`, `pendingStatus`, `executionStatus` | clears `pendingConfirmation`, sets `lastConfirmResult`, flips `status` to `'idle'`. |

If you're writing a custom renderer for `notifications/progress` or anything outside this list, you're consuming a different protocol — chat-ui events do not include MCP task notifications.

## Bearer-auth flows

The hook hard-codes `credentials: 'include'`. For Bearer-only flows, the smallest fork: copy the body of `useChat` (it's ~80 lines), swap the `fetch` call to send `Authorization: Bearer <token>` and drop `credentials`. Don't try to monkey-patch the hook from outside — there's no extension point.

Because a true Bearer fork drops `credentials` and authenticates via the `Authorization` header, it's CSRF-exempt — skip the CSRF header. But if the fork keeps cookie auth (or sends both), it stays subject to the cookie-auth CSRF check above and **must** read `CHAT_CSRF_COOKIE_NAME` and send `CHAT_CSRF_HEADER_NAME` on every turn/confirm POST.

## Testing the pure helpers

`applyChatEvent`, `buildTurnRequestBody`, `pushUserMessage` are pure functions. Test them directly with vitest (no jsdom needed):

```ts
import { applyChatEvent, initialChatUiState } from '@plumbus/chat-ui';
import { describe, expect, it } from 'vitest';

describe('applyChatEvent', () => {
  it('starts a new assistant message on message.delta', () => {
    const next = applyChatEvent(initialChatUiState, { type: 'message.delta', text: 'Hello!' });
    expect(next.messages).toEqual([{ role: 'assistant', content: 'Hello!' }]);
  });
});
```

For `useChat` itself, use jsdom + `react` test rendering. The package has no test helpers (no `/testing` subpath) — chat-ui's test surface is the pure helpers.

## Don'ts

- **Don't assume `chat.confirm` just clears local state — it's a real server round-trip.** `confirm(actionId?)` POSTs the decision to `/chat/{chatName}/confirm`; the server executes the stored, normalized action through the full pipeline (deny-by-default preserved) and resumes the turn for a final answer. Wire it to a real "Confirm" button, and use `chat.decline` for "Reject" — `chat.cancel` only dismisses locally and leaves the action unresolved server-side. See action-confirmation.md.
- **Don't mutate `chat.messages` directly.** Treat the array as immutable; the next `applyChatEvent` call returns a new array.
- **Don't poll `tasks/get` or other MCP methods from here.** chat-ui consumes the chat turn protocol, not MCP. For MCP UIs, write your own client.
- **Don't import from `./hooks/useChat-helpers.js` etc.** Always import from the package root.

## See also

- High-level path: [wiring-chat-panel.md](./wiring-chat-panel.md)
- Action confirmation: [action-confirmation.md](./action-confirmation.md)
- Server-side chat: `node_modules/@plumbus/chat/instructions/`
