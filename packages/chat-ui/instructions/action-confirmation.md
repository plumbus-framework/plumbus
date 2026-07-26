# Recipe: Action confirmation

When a chat proposes a side-effecting action, the server pauses the turn and emits a `confirmation_required` event. The user approves or declines, and **the framework does the rest** — `@plumbus/chat-ui` ships a real, first-party confirm/decline round-trip. There is no gap to fill and no capability to call by hand.

`useChat` exposes two server-backed methods:

- **`confirm(actionId?)`** — approve the pending action.
- **`decline(actionId?)`** — reject it (server-side audit trail).

Both POST to the server, which executes (on confirm) and resumes the turn for a final answer. `cancel()` is a *local-only* dismiss — see below.

## What the server emits

When the model requests an action, the runtime emits `confirmation_required`:

```ts
{
  type: 'confirmation_required',
  actionId: string,             // server-minted UUID
  capabilityName: string,       // the capability/flow the model wants to run
  confirmationMessage: string,  // human-readable text from the model
  expiresAt: string,            // ISO timestamp; the pending action expires
  schemaHash?: string,          // legacy Path A echo hash
  inputSchemaHash?: string,     // Path B: echo this back on confirm/decline
  projection?: unknown,         // Path B: validated, redacted preview for rendering
}
```

`applyChatEvent` folds this into `chat.pendingConfirmation` and flips `status` to `'awaiting_confirmation'`. The `<ConfirmationDialog />` renders it. The field the client echoes back is **`inputSchemaHash`** (not `schemaHash`).

## Confirming and declining

`confirm()` and `decline()` both POST to `confirmUrl ?? /chat/${chatName}/confirm`:

```ts
// POST /chat/:name/confirm    (credentials: 'include')
{
  actionId: string,          // pendingConfirmation.actionId (or the arg you pass)
  inputSchemaHash: string,   // echoed from pendingConfirmation.inputSchemaHash
  decision: 'confirm' | 'reject',
}
```

The hook reads `pendingConfirmation.inputSchemaHash` for you and sets `status = 'streaming'` while the request is in flight. If `inputSchemaHash` is absent (a config error, or a server that never emitted it for Path B), the hook flips `status` to `'error'` and issues **no** request.

### On confirm

The server, using only server-side state:

1. Re-resolves the tool binding for the stored `capabilityName` and checks the client-echoed `inputSchemaHash` against the current binding. Drift (a redeploy tightened the schema) is rejected with `chat.binding_changed`; an expired action returns `chat.action_expired`.
2. Executes the capability/flow **through the full framework pipeline** via `executeCapability`, with **deny-by-default access preserved** — using the **stored, normalized input**. The client never supplies the capability name or the input; both come from the pending row.
3. **Resumes the turn for a final answer.** Resume is **answer-only**: a single model completion with **no further tool rounds and no nested confirmation**.

### On decline

The server marks the pending row `rejected`, emits the rejection event, and returns immediately — **no execution, no resume**.

### The outcome the UI sees

Either decision produces a `confirmation.resolved` event, which the reducer folds into state:

- Clears `pendingConfirmation`.
- Sets `lastConfirmResult` (unless a fresh `confirmation_required` follows).

```ts
// chat.lastConfirmResult
{
  actionId: string,
  decision: 'confirm' | 'reject',
  pendingStatus: 'confirmed' | 'rejected' | 'failed' | 'indeterminate' | 'expired',
  executionStatus: 'not_requested' | 'succeeded' | 'failed' | 'indeterminate',
}
```

A confirm also streams the resumed assistant answer (`message.delta` → `turn.completed`) into `chat.messages`, exactly like a normal turn. A decline reports `executionStatus: 'not_requested'`.

## CSRF — required on every confirm/decline POST

The server enforces **exact-Origin + session-bound CSRF** on cookie-authenticated writes for **both** `/turn` and `/confirm`. `useChat` handles this automatically: it reads the non-HttpOnly cookie `plumbus_chat_csrf` (`CHAT_CSRF_COOKIE_NAME`) and echoes it in the `x-plumbus-chat-csrf` header (`CHAT_CSRF_HEADER_NAME`). Both constants are exported from `@plumbus/chat/protocol` — browser code must use that subpath, not the package root.

- **Cookie auth:** the header is mandatory — a POST without it is rejected `403`.
- **Bearer (`Authorization`) auth:** CSRF-exempt.

If you hand-roll the confirm fetch or fork the hook for Bearer auth, you **must** send `x-plumbus-chat-csrf` on every turn/confirm POST (import the constant; don't hard-code the string).

## `cancel()` vs `decline()`

- **`cancel()`** is a local-only dismiss: it sets `status` to `'idle'` and contacts the server **not at all**. The pending action stays open server-side until it expires. Kept for back-compat.
- **`decline()`** posts a `reject` decision so the server records the rejection and emits `confirmation.resolved`.

**Prefer `decline()` for the "Cancel" button** whenever you want a server-side audit trail of declined actions. Reach for `cancel()` only for a purely cosmetic dismiss.

## Using `<ChatPanel />` and `<ConfirmationDialog />`

Both are **production-ready** — the historical "v0.1 stub" is gone. `<ChatPanel />` wires the dialog straight through to the server:

```tsx
'use client';
import { ChatPanel } from '@plumbus/chat-ui';

<ChatPanel chatName="billing" sessionId={s} audience="user" locale="en" />
// Dialog "Confirm"  → chat.confirm(actionId)  → POST /chat/billing/confirm
// Dialog "Cancel"   → chat.decline(actionId)  → POST /chat/billing/confirm (reject)
```

Override the endpoint with `confirmUrl` when routes are namespaced (mirrors `turnUrl`):

```tsx
<ChatPanel chatName="billing" sessionId={s} audience="user" locale="en"
  turnUrl="/api/chat/billing/turn" confirmUrl="/api/chat/billing/confirm" />
```

`<ConfirmationDialog />` is a functional dialog: `onConfirm` and `onReject` are plain callbacks. In a custom layout, wire them to the hook:

```tsx
<ConfirmationDialog
  pendingConfirmation={chat.pendingConfirmation}
  onConfirm={() => void chat.confirm(chat.pendingConfirmation?.actionId ?? '')}
  onReject={() => void chat.decline(chat.pendingConfirmation?.actionId ?? '')}
  busy={chat.status === 'streaming'}
/>
```

## Path A vs Path B — what executes on confirm

The two ways a chat proposes actions behave differently on confirm:

| | Trigger | On confirm |
|---|---|---|
| **Path A** (legacy `requestedAction`) | `policy.action` | **Decision-only in this release** — validate, mark confirmed/rejected, emit events; the capability is never run. `policy.action.frameworkExecuteOnConfirm` is reserved and not yet enforced (no code reads it). |
| **Path B** (`policy.toolCalling`) | provider-native tool calling | **Always** executes the tool and resumes the turn for an answer. |

The client wiring is identical for both — `confirm()` / `decline()` don't change. Only the server-side effect differs.

### Path B server setup (two steps)

Path B needs one-time app wiring, or the **first** Path B turn fails with a per-turn `turn.failed` carrying `chat.prompt_not_registered` (this is *not* a boot/startup error):

1. **Re-export the tool-calling prompts.** Re-export `chatToolRoundPrompt` and `chatScopeCheckPrompt` from `@plumbus/chat` into `app/prompts/` (directory-discovered, same one-time wiring as `chat.turn`).
2. **Pass a `chatRegistry`.** Build `createChatRegistry(promptRegistry)` (it takes the runtime `PromptRegistry` — any object with `has(name)`) and pass it as the `chatRegistry` field of the `registerChatRoutes(app, config, chats, { store, chatRegistry })` options.

Path B also requires a **transactional** conversation `store`; a non-transactional adapter fails closed with `chat.storage_unsupported`.

## Don'ts

- **Don't call `confirm()`/`decline()` while streaming a turn.** They target the pending confirmation for the current session; issue them from the `'awaiting_confirmation'` state.
- **Don't send the capability name or input from the client on confirm.** The server uses the stored, normalized input; client-supplied values are ignored.
- **Don't use `cancel()` when you need an audit trail.** It never reaches the server — use `decline()`.
- **Don't hard-code the CSRF cookie/header strings.** Import `CHAT_CSRF_COOKIE_NAME` / `CHAT_CSRF_HEADER_NAME` from `@plumbus/chat/protocol` (browser-safe; the package root drags `node:crypto` and the CLI into a client bundle).

## See also

- Hook return shape and custom layouts: [custom-ui.md](./custom-ui.md)
- Wiring the panel: [wiring-chat-panel.md](./wiring-chat-panel.md)
- Server-side action policy (Path A / Path B): `node_modules/@plumbus/chat/instructions/policies.md`
- Defining chats with actions/tool calling: `node_modules/@plumbus/chat/instructions/defining-chats.md`
