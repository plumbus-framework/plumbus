# Recipe: Action confirmation (the `confirm()` gap)

This is the most surprising part of `@plumbus/chat-ui`. **`useChat.confirm(actionId)` does NOT call the server.** It clears local `pendingConfirmation` state and sets `status = 'idle'`. Nothing else.

Apps that ship action-confirmation flows must call the server-side `chatConfirmAction` capability **directly**. The hook surfaces every field the server needs — `actionId`, `capabilityName`, `schemaHash` — so apps can wire the round-trip in ~20 lines.

## What the server emits

When the post-turn `action-guard` proposes an action, the runtime emits a `confirmation_required` event:

```ts
{
  type: 'confirmation_required',
  actionId: string,          // server-minted UUID
  capabilityName: string,    // the capability the model wants to call
  confirmationMessage: string, // human-readable text from the model
  expiresAt: string,         // ISO timestamp; the pending action expires
  schemaHash?: string,       // hash of the capability's input schema at propose time
}
```

`applyChatEvent` stores this on `chat.pendingConfirmation` and flips `status` to `'awaiting_confirmation'`. The `<ConfirmationDialog />` component renders it.

## What the agent must call

The auto-routed capability `chatConfirmAction` at `POST /api/chat/chat-confirm-action`. Input:

```ts
{
  actionId: string,       // from pendingConfirmation.actionId
  capabilityName: string, // from pendingConfirmation.capabilityName
  schemaHash: string,     // from pendingConfirmation.schemaHash
  execute: boolean,       // true to execute; false to reject without running
}
```

The server:
1. Loads the pending action.
2. **Re-hashes the capability's current input schema and compares to `schemaHash`.** If they differ (e.g. a redeploy tightened the schema since the action was proposed), the call is rejected with `chat.action_schema_changed`. This is the security primitive.
3. Re-validates input against the current schema.
4. Executes the capability via the standard `executeCapability` path.
5. Marks the action `confirmed`.

The `schemaHash` round-trip means: what the user confirmed is exactly what gets executed.

## Recipe

```tsx
'use client';
import { useChat } from '@plumbus/chat-ui';

export function MyChat({ sessionId }: { sessionId: string }) {
  const chat = useChat({ chatName: 'billing', sessionId, audience: 'user', locale: 'en' });

  async function realConfirm() {
    const pa = chat.pendingConfirmation;
    if (!pa || !pa.schemaHash) {
      console.error('No schemaHash on pending action — server is pre-0.1.4 or action-guard misconfigured');
      return;
    }
    const res = await fetch('/api/chat/chat-confirm-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        actionId: pa.actionId,
        capabilityName: pa.capabilityName,
        schemaHash: pa.schemaHash,
        execute: true,
      }),
    });
    if (!res.ok) {
      // Likely chat.action_schema_changed — the schema drifted; ask the user again.
      const err = await res.json();
      console.error('Confirm rejected:', err);
      return;
    }
    chat.cancel();  // clears local pendingConfirmation; ok because the server already executed.
  }

  return (
    <>
      {chat.pendingConfirmation && (
        <div role="dialog">
          <p>{chat.pendingConfirmation.confirmationMessage}</p>
          <button onClick={() => void realConfirm()}>Confirm</button>
          <button onClick={chat.cancel}>Cancel</button>
        </div>
      )}
      {/* ... rest of the UI ... */}
    </>
  );
}
```

**Do NOT use `<ChatPanel />`'s built-in confirmation dialog for production action-confirmation flows.** Its `onConfirm` calls `useChat.confirm` which is the stub. For now, either use a custom layout with `<ChatMessages />` + `<ChatInput />` and your own dialog, or fork the panel.

## What happens if you don't wire this

The user clicks "Confirm" → `useChat.confirm()` clears `pendingConfirmation` locally → the user thinks the action executed → **nothing happened server-side**. The pending action expires at `expiresAt` and is garbage-collected. The model thinks the action was rejected.

This will silently miss every action confirmation in the app. The audit logs will show pending actions that never confirmed.

## Rejecting instead of confirming

Same recipe with `execute: false`. The server marks the action `rejected` and emits the appropriate event. Use for the "Cancel" button when you want a server-side audit trail of declined actions.

```ts
body: JSON.stringify({
  actionId: pa.actionId,
  capabilityName: pa.capabilityName,
  schemaHash: pa.schemaHash,
  execute: false,
}),
```

## Why the recipe is required

`useChat.confirm()` does not call the server, so **every action-confirmation flow needs the recipe above** — there is no shortcut. A first-party `useChat → chatConfirmAction` round-trip (likely a `confirm(actionId, { execute })` that calls the server, plus a `<ConfirmationDialog />` wired through `<ChatPanel />`) would supersede it; the contract above (action capability shape, schemaHash check) would stay the same.

## See also

- Server-side action-guard: `node_modules/@plumbus/chat/instructions/policies.md` (action section)
- The `chatConfirmAction` capability: `packages/chat/src/capabilities/chat-confirm-action.ts` in the Plumbus monorepo
- Hook return shape: [custom-ui.md](./custom-ui.md)
