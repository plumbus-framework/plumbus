# Session store adapters

By default a chat persists to the `ChatSession`, `ChatTurn`, and `ChatPendingAction`
entities through `ctx.data` — your app's PostgreSQL database. Some deployments cannot
do that. A module that reaches its conversation memory through a remote platform, a
port, or another service has no local database, so `ctx.data.ChatSession` does not
exist and the stock pipeline cannot run.

`runChatTurn` accepts an optional third argument for exactly this case:

```ts
runChatTurn(ctx, args, { sessionStore, conversationStore });
```

Both fields are optional. Omit them and nothing changes — the DB-backed default is
used, which is what every existing application already gets.

The point of the seam is to remove the reason to fork. Before it existed the only way
to run a chat on non-DB memory was to re-implement the turn pipeline out of the
exported pieces (`compilePolicy`, `resolveContextSources`, `buildSystemPrompt`,
`validateCitations`) and hand-roll session I/O around them. Such a fork drifts from
upstream on every release. A store adapter keeps you on the real pipeline.

## Two tiers

Storage is split in two, because the two halves have very different requirements.

| Tier | Interface | Required? | Covers |
|---|---|---|---|
| 1 | `ChatSessionStore` | Yes, to inject at all | Session bootstrap, turn append/read, behavioral state, summaries, budget rollups |
| 2 | `ChatConversationStore` | Optional | Tool confirmations and pending actions — lease-based, atomic multi-row commits |

Tier 1 is ordinary session I/O. Any backend that can store and read records can
implement it.

Tier 2 needs conditional (compare-and-set) writes and a session mutation lease so a
confirmed action cannot double-execute or interleave with a concurrent turn. That is a
real constraint, and a remote memory port often cannot satisfy it. Rather than weaken
the guarantee, the framework treats tier 2 as opt-in: a deployment that supplies only
tier 1 gets the full conversational pipeline, and confirmations are refused rather
than committed non-atomically.

## Implementing tier 1

```ts
import type { ChatSessionStore } from '@plumbus/chat';

export const platformSessionStore: ChatSessionStore = {
  async getOrCreateSession(ctx, args) {
    /* ... */
  },
  async loadSession(ctx, sessionId) {
    /* ... */
  },
  async appendTurn(ctx, turn, opts) {
    /* ... */
  },
  async countTurns(ctx, sessionId) {
    /* ... */
  },
  async listTurns(ctx, sessionId, opts) {
    /* ... */
  },
  async updateSessionBehavioralState(ctx, sessionId, behavioralState) {
    /* ... */
  },
  async updateSessionSummary(ctx, sessionId, summaryText, summaryTurnCount) {
    /* ... */
  },
  async loadMergedUserBehavioralState(ctx, userId, limit) {
    /* ... */
  },
};
```

Every method takes `ctx` first. That is deliberate: an adapter fronting a remote
platform normally reaches it through `ctx.capabilities` or an app-owned port, so it
needs the execution context that the current turn is running under — including its
auth and tenant scoping.

`createInMemoryChatSessionStore` from `@plumbus/chat/testing` implements this whole
required surface, plus `aggregateForBudget` and `createSession`. Start from it. It
deliberately omits `countActivePendingActions`, which is meaningless without tier 2 —
see [Optional methods](#optional-methods) below.

### Optional methods

| Method | Needed when |
|---|---|
| `aggregateForBudget` | The chat declares any `budget`. Rolls up turns, tokens, spend, and user messages across a session, user, or tenant so a turn over the cap can be refused. This is cap **enforcement** only — recording what each call cost is core's job and needs nothing from your store. |
| `countActivePendingActions` | The chat sets `budget.actions.perSession`. Counts a session's live pending actions, retiring lapsed ones. |
| `createSession` | Your app bootstraps sessions explicitly. `runChatTurn` never calls it — it uses `getOrCreateSession`. |

These are optional because they are the ones a constrained backend is least likely to
support. `aggregateForBudget` in particular is an analytics query across sessions, not
session I/O.

A missing optional method is never silently tolerated when the chat needs it. Skipping
`aggregateForBudget` would leave a configured spend cap unenforced, so the framework
fails closed instead — see [Startup validation](#startup-validation).

### Invariants an adapter must honor

These are load-bearing for the rest of the pipeline. The DB-backed default implements
them; an adapter that does not will corrupt transcripts in ways the type system cannot
catch.

- **`appendTurn` assigns the ordinal.** The caller passes `ordinal: 0` as a
  placeholder. Derive the real value from how many turns the session already has, so
  reading rows back in ordinal order reproduces the conversation. Also advance the
  session's `lastTurnAt` to the appended turn's `recordedAt`.
- **`appendTurn` honors `persistContent`.** When it is `false` — a chat configured with
  `persistence.messageContent: 'client'` — store the row with an empty `content`.
  Metadata (tokens, cost, model, sources) is still recorded. Treating the flag as
  advisory leaks exactly the message bodies the operator chose not to retain.
- **`getOrCreateSession` enforces ownership.** If a session exists under the requested
  id but belongs to a different `userId`, raise `ctx.errors.notFound` instead of
  returning it. Otherwise a guessed session id reads another user's conversation.
  Concurrent first turns racing the same id must converge on one row.
- **`listTurns` returns ascending ordinal order,** and `limit` truncates from the
  start of that ordering. Note this yields the *oldest* N turns, matching the
  DB-backed `history.includeLastTurns` behavior.
- **`loadMergedUserBehavioralState` merges oldest → newest,** so later sessions win on
  key collision. Cooldowns declared with `scope: 'user'` are only enforceable across
  sessions if this reflects other sessions' state.

One divergence to be aware of: the DB-backed default goes through core's
`Repository.findMany`, which clamps `limit` to the range 1–100. An adapter that honors
the raw limit will return different results than the default for
`includeLastTurns: 0` or values above 100. Clamp the same way if exact parity matters
to you.

## Wiring it up

Through HTTP routes:

```ts
registerChatRoutes(app, routeConfig, chats, {
  sessionStore: platformSessionStore,
  // store: myConversationStore,   // optional tier 2
  authenticator,
});
```

Through the capability surface:

```ts
createChatTurnCapability(chat, { sessionStore: platformSessionStore });
```

Directly:

```ts
for await (const evt of runChatTurn(ctx, args, { sessionStore: platformSessionStore })) {
  // ...
}
```

Guards receive the store too. A custom guard that needs session state should read
`state.sessionStore` rather than `ctx.data`, falling back to the default when it is
absent:

```ts
import { resolveChatSessionStore } from '@plumbus/chat';

const myGuard: Guard = async (turnCtx, state) => {
  const store = resolveChatSessionStore(state.sessionStore);
  const session = await store.loadSession(state.ctx, turnCtx.sessionId);
  // ...
};
```

## Startup validation

`registerChatRoutes` calls `assertChatStoresSupportChats` for every registered chat.
It is a no-op unless a `sessionStore` is injected — applications that inject nothing
are unaffected — and it throws `ChatStoreUnsupportedError` when a chat needs something
the supplied stores cannot do:

| Condition | Error code |
|---|---|
| Chat declares a `budget`, store has no `aggregateForBudget` | `chat.budget_unsupported` |
| Chat sets `budget.actions.perSession`, store has no `countActivePendingActions` | `chat.budget_unsupported` |
| Chat can raise confirmations (`policy.toolCalling.enabled`, or `policy.action.allowedCapabilities`) and no `conversationStore` was supplied | `chat.storage_unsupported` |

Call it yourself if you drive `runChatTurn` without the HTTP layer:

```ts
import { assertChatStoresSupportChats } from '@plumbus/chat';

assertChatStoresSupportChats({ chats, sessionStore, conversationStore });
```

The same conditions also fail closed at turn time, so a direct caller that skips the
startup check still cannot silently run with an unenforced budget. Confirmations
raised by a tier-1-only deployment emit a `chat.storage_unsupported` notice and no
pending action is created.

## What an adapter does not change

An injected store replaces chat persistence only. The turn still needs the rest of the
execution context, and those subsystems are unaffected:

- `ctx.ai` — every model call, including the scope preflight and summarizer.
- `ctx.events` — `chatTurnCompletedEvent` and `chatRefusalRecordedEvent`.
- `ctx.auth` — the session's `userId` and `tenantId` come from here.
- `ctx.time`, `ctx.errors`.
- `ctx.audit` — capability execution reached from `capabilityContext` or tool calling
  records audit entries through core.

### Cost tracking is not budget enforcement

These are separate systems, and only the second one cares about your store.

**Cost tracking** happens inside core's AI service, in `recordProviderCost`. Every
provider call updates the in-memory cost tracker and fires the app's
`onAICostRecorded` hook, tagged with the `costContext` chat attaches
(`serviceArea: 'chat'`, `operationName: 'chat.<name>'`). None of it reads
`ChatSession` or `ChatTurn`, so an injected store does not change what is recorded.

**Budget enforcement** (`budget.*` on a chat) is the separate question of whether to
*refuse a turn* that would exceed a cap. That answer is computed by aggregating stored
turn rows, which is why it needs `aggregateForBudget` from your store.

So `chat.budget_unsupported` means "this store cannot enforce a cap." It never means
spend has stopped being recorded.

One thing to wire up separately on a database-free deployment: the AI service always
fires `onAICostRecorded`, but whether that record is *persisted* is up to the hook. The
standard `createServer` wiring hands the hook a `db` handle and writes there, so an app
without a database needs to point its hook somewhere else. That is independent of chat.

### Limitations

- **`ctx.data` is still required by `ExecutionContext` itself.** Core's context type
  declares `data` as non-optional and `createServer` requires a database, so a store
  adapter makes the *chat pipeline* database-free, not the whole framework. An
  application composing its own `ExecutionContext` controls what it puts there; an
  application on `createServer` still stands up a database even if chat no longer
  writes to it.
- **`chatConfirmAction` and `chatListTurns` read `ctx.data` directly.** They are
  module-level capabilities with no injection point. A tier-1-only deployment does not
  use `chatConfirmAction` anyway (it has no confirmations); `chatListTurns` should be
  replaced with your own read capability against the same backend.

## Testing

`@plumbus/chat/testing` exports `createInMemoryChatSessionStore`, a Map-backed store
that never touches `ctx.data`:

```ts
import { createInMemoryChatSessionStore } from '@plumbus/chat/testing';

const store = createInMemoryChatSessionStore();

for await (const evt of runChatTurn(ctx, args, { sessionStore: store })) {
  events.push(evt);
}

expect(store.__turns).toHaveLength(2);
expect(store.__turns.map((t) => t.ordinal)).toEqual([0, 1]);
```

`mockChatRuntime` takes the same options bag as a fourth argument.

To prove an adapter path is genuinely free of `ctx.data`, run the turn against a
context whose `data` throws on any access. The framework's own suite does this in
`packages/chat/src/session/__tests__/session-store-injection.test.ts` — copy the
`contextWithoutData` helper for your own adapter's conformance test.

See also [testing.md](./testing.md) for the general chat test helpers.
