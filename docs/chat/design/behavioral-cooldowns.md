# Behavioral cooldowns for stateful abuse patterns

> **Locked.** `policy.behavioral.cooldowns` slot.

## The problem

Some abuse-shaped behaviors don't fit either of the framework's two existing rate-limit primitives:

- **Budgets** are count-based and per-axis (per-turn, per-session, per-user, per-tenant tokens / cost / turns). They don't express "after N events, lock the chat for M seconds."
- **Guards** are per-turn pass/fail. They don't carry state across turns.

Real patterns observed in production help bots:

- "After 3 refusals in this conversation, cool down for 30 seconds." Prevents users from spamming off-topic messages to probe for jailbreaks.
- "After 5 consecutive guard failures by this user, block for 60 seconds." User is actively misusing.
- "After a budget-exceeded turn, wait 10 seconds before accepting another request from this user." Soft backoff before the next attempt.

None of these fit either primitive cleanly.

## How it works

`policy.behavioral.cooldowns` is an explicit slot for stateful pattern detection:

```ts
policy: {
  behavioral: {
    cooldowns: Array<{
      trigger: 'refusal' | 'guardFailure' | 'budget';
      count: number;
      windowSeconds?: number;       // optional sliding window
      durationSeconds: number;
      scope?: 'session' | 'user';   // default 'session'
    }>;
  };
}
```

State lives on `ChatSession.behavioralState` (jsonb). The `behavioral-guard` runs at two points:

- **Pre-turn:** reads `behavioralState`, checks each cooldown. If any is active, returns `block` with `notice: chat.cooldown_active` carrying `retryAfterSeconds`.
- **Post-turn:** increments counters for whichever triggers fired this turn (refusal, guard failure, budget breach).

Counter updates use atomic `UPDATE … RETURNING` to handle concurrent turns racing on the same session.

`scope: 'session'` resets when the session ends; `scope: 'user'` persists across sessions for the same user (stored on a per-user table or aggregated from `ChatTurn` queries — implementation detail).

## Tradeoffs

**What works well:**
- Real production abuse patterns expressible declaratively.
- Behavior is observable in the trace (`trace.events.notice` events).
- Atomic counter updates eliminate the race condition that read-modify-write would create.

**What you give up:**
- Adds a jsonb column to `ChatSession`. Migration cost is trivial; querying / debugging stateful counters is slightly harder than stateless ones.
- The trigger enum is small (`refusal | guardFailure | budget`). Custom triggers ("session sentiment turned negative") would need custom guards that piggyback on the same state slot.
- The `scope: 'user'` variant requires either a separate per-user state table or a query over `ChatSession` for that user. The runtime uses the latter; if performance becomes an issue, extract a `ChatBehavioralState` entity.

## Out of scope

- Dynamic cooldown duration ("double the cooldown each time it triggers").
- Cross-trigger cooldowns ("cooldown if EITHER refusal OR guard-failure passes threshold").

Add when needed; don't speculate.

---

## Addendum (2026-07-08) — C8 enforcement semantics

**Implemented:** `windowSeconds` sliding windows; `guardFailure` and `budget` triggers wired from `run-turn` via `lastBudgetOrGuardSignal`; refusal cooldowns in ephemeral mode from `clientHistory.refusalReason`.

**Concurrency:** Counter updates remain read-modify-write on `ChatSession.behavioralState` — not `UPDATE … RETURNING`. Document last-writer-wins under concurrent turns.

**User scope:** Keys use `user:{userId}` on the current session row. Counters do not automatically aggregate across new session rows (cross-session user scope is still an open enhancement).
