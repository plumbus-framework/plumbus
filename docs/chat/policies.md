# Policies

The `policy` block on a chat config is declarative. The runtime compiles it into an ordered pipeline of guards that run pre- and post-turn. Custom guards (`policy.custom`) are an escape hatch; the seven built-ins should cover most needs.

## Guard ordering

```
preTurnGuards: audience → locale → behavioral → custom
                                                     ↓
                                          context resolution
                                                     ↓
                                              model call
                                                     ↓
postTurnGuards: provenance → scope → privacy → action → behavioral (postflight) → customPostTurn
```

The order is fixed — you can't reshuffle it. Custom guards run at the end of their phase:

- **`policy.custom`** runs at the end of the **pre-turn** phase (after `audience` → `locale` → `behavioral`), before context resolution and the model call. It sees the incoming turn but **not** the model's output.
- **`policy.customPostTurn`** runs at the end of the **post-turn** phase (after all built-ins), with `state.modelOutput` available — for inspecting, redacting, or confirming based on the model's answer.

Each guard returns one of three verdicts:

```ts
type GuardVerdict =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string; emit?: Partial<ChatEvent> }
  | { decision: 'require_confirmation'; pendingAction: PendingAction };
```

A `'block'` verdict from a **pre-turn** guard ends the turn with a `turn.failed` event (plus the optional `emit` notice) before the model runs. Post-turn `'block'` verdicts emit their `emit` notice but do **not** emit `turn.failed` — mutate `state.modelOutput.answer` (or rely on built-ins like `scope-classifier`) to change what the client sees. A `'require_confirmation'` verdict stores a pending action and emits `confirmation_required`; the client then calls the `chatConfirmAction` capability with the pending action ID (see [action-guard](#action-guard-post-turn) below).

## Built-in guards in detail

### `audience-guard` (pre-turn)

```ts
policy: { audience: { roles: ['user', 'admin'], mode: 'strict' | 'permissive' } }
```

- `'strict'` (default): the caller must have at least one of the listed roles via `ctx.security.hasRole`. Missing → `block`.
- `'permissive'`: missing role does not block; the turn uses the caller-supplied `audience` string as-is (`policy.audience.default` is accepted by the schema but not substituted today).

Threads `audience` into `TurnContext` so context-source filters and the prompt anchor see it.

### `locale-guard` (pre-turn)

```ts
policy: {
  scope: { locales: ['en', 'he'] },
  reply: { locale: 'auto' | 'en' | 'he' },
}
```

- When `policy.scope.locales` is set, blocks turns whose `turnCtx.locale` is not in the whitelist (`notice: chat.locale_denied`).
- `policy.reply.locale` is **not** enforced by this guard — it is threaded into `buildSystemPrompt` after guards run (see below).

**Reply language anchor (`policy.reply.locale`):** `runChatTurn` passes `replyLocale: policy.reply?.locale` into `buildSystemPrompt`. When `reply.locale` is `'auto'` or omitted, the anchor uses `turnCtx.locale`. When set to a concrete locale (e.g. `'en'`), that locale wins in the `[Reply in '{locale}' only.]` line regardless of the turn's `locale` field. Runtime-emitted notices (cooldown, audience denial, locale denial) remain hardcoded English except the out-of-scope refusal copy, which resolves through `ctx.translations` when available.

### `behavioral-guard` (pre + post)

```ts
policy: {
  behavioral: {
    cooldowns: [
      { trigger: 'refusal', count: 3, durationSeconds: 30, scope: 'session' },
      { trigger: 'guardFailure', count: 5, windowSeconds: 60, durationSeconds: 60, scope: 'user' },
    ],
  },
}
```

State lives on `ChatSession.behavioralState` (jsonb). Pre-turn the guard reads it; if any cooldown is active, the turn is `block`ed with a `notice: chat.cooldown_active` carrying `retryAfterSeconds`. Post-turn the guard increments counters for whichever triggers fired this turn.

Triggers:
- `'refusal'` — the model returned `inScope: false`.
- `'guardFailure'` — a guard returned `block` (pre-turn or post-turn; provenance/action budget blocks count as `'budget'`).
- `'budget'` — a per-turn token/cost cap fired or an action/provenance budget guard blocked.

`windowSeconds`, when set, implements a sliding window: counters reset when the window elapses before `count` is reached.

`scope: 'session'` keys counters to the current `sessionId`; `scope: 'user'` keys them to `user:{userId}` and merges `behavioralState` from the caller's recent sessions (up to 50 rows, oldest → newest precedence) so cooldowns can span new session rows for the same user.

Counter updates are read-modify-write on `ChatSession.behavioralState` (not `UPDATE … RETURNING`). High-concurrency deployments should expect last-writer-wins on the jsonb blob.

When `persistence.saveToDb: false`, the pre-turn guard enforces refusal cooldowns from `clientHistory` assistant `refusalReason` fields only; post-turn persistence is a no-op.

### `scope-classifier` (post-turn)

```ts
policy: { scope: { description: 'Caller\'s own billing only.', classifier: 'inline' } }
```

Reads the model's `inScope` boolean. If `false`, emits `notice: chat.out_of_scope` with localized refusal copy — it does **not** replace `answer`; the model's response text is already streamed to the client. The classifier is **inline** — the model classifies and answers in one call (Decision 0001). No preflight LLM call, no second roundtrip. Tradeoff: refusal turns spend generation tokens. Empirically cheaper than preflight because most turns are in-scope.

`policy.scope.classifier` accepts `'inline'` (the default) or `'custom'`, but the runtime only implements the inline path — `'custom'` is accepted by the schema and behaves identically to `'inline'` today.

### `privacy-guard` (post-turn)

```ts
policy: { privacy: { redact: ['ssn', 'cardNumber', 'paymentMethodFullNumber'] } }
```

Substring-replaces matching tokens in `output.answer` with `[redacted]`. **Limitation: substring match only — do NOT rely on this for real PII compliance.** Structured PII detection (regex patterns for emails, credit cards, phone numbers, etc.) is not implemented.

### `provenance-guard` (post-turn)

```ts
policy: { provenance: { required: true, minSources?: 1 } }
```

Runs the runtime's citation validator:
1. Read `output.citedSources` (array of source IDs the model claims to cite).
2. Validate each against `guardState.resolvedSources` (the set of runtime-issued handles, e.g. `src_a`, `src_b`).
3. Invalid IDs are stripped from the answer (any `[src:invalid_id]` markers removed).
4. If `required: true` and zero valid citations remain → `block` with `notice: chat.provenance_missing`.
5. If `minSources` is set and valid citations are fewer → `block` with `notice: chat.provenance_insufficient`.

Persistence stores only the validated cited subset on `ChatTurnRow.sources`, not the full retrieved set. The model **cannot** invent source IDs — the runtime never accepts a citation that wasn't issued.

### `action-guard` (post-turn)

```ts
chat = defineChat({
  actions: ['openSupportTicket'],
  policy: { action: { allowedCapabilities: ['openSupportTicket'] } },
});
```

When the model returns `output.requestedAction = { capabilityName, input, confirmationMessage }`:

1. Look up `capabilityName` against `policy.action.allowedCapabilities` (deny by default).
2. Re-validate `input` against the capability's current Zod input schema when the capability is resolvable (`notice: chat.action_input_invalid` on failure).
3. Compute `schemaHash` and store it on the `ChatPendingAction` row:
   - **v2 (preferred):** `v2:` + sha256 of `ctx.capabilities.describe(name).inputSchema` when describe is available.
   - **Legacy fallback:** sha1 of `JSON.stringify(input)` when describe is unavailable (warns once per capability).
4. Enforce `budget.actions.perSession` by counting pending rows for the session before storing a new one.
5. Return `decision: 'require_confirmation'` — the runtime emits `confirmation_required` with the action ID and `schemaHash`.

The server-side confirmation capability (`chatConfirmAction`, auto-routed at `POST /api/chat/chat-confirm-action`) takes `{ actionId, capabilityName, schemaHash, execute }`. The client gets all three from the `confirmation_required` event. On confirm (`execute: true`) the capability:

1. Loads the pending action and verifies session ownership.
2. Compares the client-echoed `schemaHash` to the stored row (`chat.action_schema_mismatch` on mismatch).
3. For **v2** hashes, re-derives the live capability input schema via `ctx.capabilities.describe` and rejects with `chat.action_schema_changed` when the schema drifted since propose.
4. Re-validates stored input against the current Zod schema.
5. Marks the action `confirmed` and emits `chat.action.confirmed`.

**`chatConfirmAction` does not execute the target capability today.** The handler validates, updates pending-action status, and returns `{ executed: true }` with a stub result. Apps that need real side effects must call `executeCapability` (or a domain capability) in their own wiring after a successful confirm response.

This `schemaHash` check is still load-bearing: it guarantees the user confirmed against the schema that was live at propose time. The client carries `schemaHash` as a witness — the server re-derives v2 hashes from the live schema.

> **UI wiring gap.** `useChat`'s `confirm(actionId)` in `@plumbus/chat-ui` only clears local UI state — it does **not** call `chatConfirmAction` on the server. Apps that ship action-confirmation flows should read `pendingConfirmation` off the hook (it carries `actionId`, `capabilityName`, and `schemaHash`) and call `chatConfirmAction` directly via the auto-routed endpoint; see [`packages/chat-ui/src/hooks/useChat.ts`](../../packages/chat-ui/src/hooks/useChat.ts).

## Custom guards (`policy.custom`, `policy.customPostTurn`)

Escape hatch for behavior the built-ins don't cover. Both slots take `Guard[]`, run in declaration order at the end of their phase, and share the same signature — the difference is **when** they run and therefore what they can see.

### `policy.custom` — pre-turn (input gating)

Runs after the pre-turn built-ins, **before the model call**. Receives `turnCtx` (including `userMessage`) and `state` (`policy`, `ctx`, `resolvedSources`, `clientHistory`) but **not** `state.modelOutput` (the model hasn't run yet). A `block` verdict ends the turn before any tokens are spent.

```ts
const blockBannedTerms: Guard = async (turnCtx, _state) => {
  if (turnCtx.userMessage?.toLowerCase().includes('forbidden')) {
    return {
      decision: 'block',
      reason: 'my.custom_violation',
      emit: { type: 'notice', code: 'my.custom_violation', message: 'Not allowed.' },
    };
  }
  return { decision: 'allow' };
};

defineChat({ policy: { custom: [blockBannedTerms] } });
```

### `policy.customPostTurn` — post-turn (output moderation)

Runs after all post-turn built-ins, with `state.modelOutput` available. Use it to inspect, redact, or require confirmation based on the model's answer.

**Important — to change the response, mutate `state.modelOutput.answer`.** In the post-turn phase a `block` verdict emits its `emit` notice but does **not** suppress the answer (this is the same contract the built-in `privacy` and `scope` guards use). To redact or replace output, mutate `state.modelOutput.answer` directly:

```ts
const redactSecrets: Guard = async (_turnCtx, state) => {
  if (state.modelOutput && typeof state.modelOutput.answer === 'string') {
    state.modelOutput.answer = state.modelOutput.answer.replace(/\bsk-[a-z0-9]+\b/gi, '[redacted]');
  }
  return { decision: 'allow' };
};

defineChat({ policy: { customPostTurn: [redactSecrets] } });
```

If you find yourself writing the same custom guard across multiple chats, file an issue — the right answer is usually a new built-in.

## What's NOT a policy

- **Authentication.** That's the `access` block (standard Plumbus AccessPolicy). Policies run *after* the framework has authenticated the caller.
- **Rate limiting at the HTTP level.** Use budget `perUser.turnsPerHour` instead — it's chat-aware and respects sessions.
- **Capability execution semantics.** Capabilities own their own `access`, `effects`, retry rules. The chat's `action-guard` only mediates the confirmation flow.
