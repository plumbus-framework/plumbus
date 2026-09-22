# Server vs client message persistence

> **Locked.** `persistence.messageContent: 'server' | 'client'`. Default `'server'`.

## The problem

`ChatSession` and `ChatTurn` are framework-owned entities. Storing message content on `ChatTurn.content` gives the runtime everything it needs for:

- History hydration across devices ("I closed the tab, reopened on my phone, conversation still there").
- Audit trail of what the bot said and what the user asked.
- Server-side analytics on common questions, refusal patterns, etc.

But some consumers don't want this:

- **Privacy-first apps.** MemoirAI's help-bot kept conversations in `localStorage` only before being migrated to the framework. Adding server-side message content was a behavioral change with privacy implications.
- **Regulated domains.** Some jurisdictions / industries require minimizing PII persistence.
- **Throwaway chats.** Anonymous public-facing chats may have no use for persistent prose.

A binary choice (everything-or-nothing) is too coarse. The right shape is: turn **metadata** is always persisted (abuse limits, budgets, cost ledger all need it); turn **prose** is opt-out.

## How it works

`defineChat({ persistence: { messageContent: 'server' | 'client' } })`. Default `'server'`.

In `'server'` mode:
- `ChatTurnRow.content` stores the full user message / assistant answer.
- History hydration uses `loadHistoryWindow` against `ChatTurn` rows.
- UI can call `chatListTurns` to render prior turns on reload.

In `'client'` mode:
- `ChatTurnRow.content` stores `''` (empty string).
- The client UI is the source of truth for prose; it keeps history in `localStorage` (or wherever).
- On every `POST /chat/:name/turn` the client sends the last 20 messages as `clientHistory: Array<{role, content}>`.
- The runtime uses `args.clientHistory` instead of `loadHistoryWindow` when persistence is client.
- Server validates `clientHistory` and rejects with `400 + chat.client_history_too_large` if > 20 messages or any message > 4000 chars.

Turn **metadata** is always persisted regardless of mode: `inScope`, `refusalReason`, `tokensIn/Out`, `costUsd`, `model`, `latencyMs`, `recordedAt`, `sources` (cited subset), `actionRequested?`, `actionConfirmed?`. These are needed for abuse limits, budgets, cost ledger.

## Tradeoffs

**What works well:**
- Server-persistence (default) gives audit, cross-device, analytics for free.
- Client-persistence respects privacy-first consumer requirements without re-architecting.
- Metadata persistence is non-negotiable — abuse limits and budgets work in either mode.

**What you give up:**
- Two modes to test for every consumer-facing surface. Test coverage includes both paths (`run-turn.test.ts` persistence-modes suite).
- Client-supplied `clientHistory` cannot be trusted for abuse computations — a malicious client can lie about its conversation. The runtime treats it as model-context-only.
- Migrating an existing client-persistence chat to server-persistence requires deciding what to do with the gap (history before migration is gone unless backfilled from client localStorage).

## Trust boundary (security-load-bearing)

The client-supplied `clientHistory` is **not authoritative** for any policy decision. Abuse limits, budgets, cooldown counters, and cost tracking all compute from server-persisted `ChatTurn` metadata. Forging `clientHistory` can change what the model sees in context — it cannot inflate the user's own limits or bypass cooldowns.

This boundary is the reason metadata persistence is mandatory. If both content and metadata lived client-side, the runtime would have no way to enforce any limit.

---

## Addendum (2026-07-08)

**`persistence.saveToDb: false`:** Ephemeral chats write no chat-table rows. Cooldowns and per-session message caps then derive from client-supplied `clientHistory` (including each assistant message's `refusalReason`). A client that omits refusal metadata or trims history can weaken those limits. Cross-link: [defining-chats.md](../defining-chats.md#persistencesavetodb).
