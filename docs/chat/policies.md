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

A `'block'` verdict ends the turn with a `turn.failed` event (plus the optional `emit` notice). A `'require_confirmation'` verdict stores a pending action and emits `confirmation_required`; the client then calls the `chatConfirmAction` capability with the pending action ID to execute it (see [action-guard](#action-guard-post-turn) below).

## Built-in guards in detail

### `audience-guard` (pre-turn)

```ts
policy: { audience: { roles: ['user', 'admin'], mode: 'strict' | 'permissive' } }
```

- `'strict'` (default): the caller must have at least one of the listed roles via `ctx.security.hasRole`. Missing → `block`.
- `'permissive'`: the turn proceeds but the audience anchor in the system prompt is set to `policy.audience.default ?? 'unknown'`. Useful for public chats where roles are advisory, not gating.

Threads `audience` into `TurnContext` so context-source filters and the prompt anchor see it.

### `locale-guard` (pre-turn)

```ts
policy: {
  scope: { locales: ['en', 'he'] },
  reply: { locale: 'auto' | 'en' | 'he' },
}
```

- Normalizes `turnCtx.locale` against the `scope.locales` whitelist if present. Missing → `block`.
- If `reply.locale === 'auto'`, the prompt anchor is `[Reply in '{turnCtx.locale}' only.]`. Otherwise the anchor is hardcoded to `reply.locale`.

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
- `'guardFailure'` — any post-turn guard returned `block`.
- `'budget'` — budget enforcer threw.

`scope: 'session'` resets per-session; `scope: 'user'` persists across sessions for the same user. Atomic counter updates use `UPDATE … RETURNING` to handle concurrent turns.

### `scope-classifier` (post-turn)

```ts
policy: { scope: { description: 'Caller\'s own billing only.', classifier: 'inline' } }
```

Reads the model's `inScope` boolean. If `false`, replaces `answer` with the localized refusal copy and emits `notice: chat.out_of_scope`. The classifier is **inline** — the model classifies and answers in one call (Decision 0001). No preflight LLM call, no second roundtrip. Tradeoff: refusal turns spend generation tokens. Empirically cheaper than preflight because most turns are in-scope.

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
2. Re-validate `input` against the capability's current Zod input schema.
3. Compute `schemaHash` (hash of the current input schema) and store it on the `ChatPendingAction` row.
4. Return `decision: 'require_confirmation'` — the runtime emits `confirmation_required` with the action ID.

The server-side confirmation capability (`chatConfirmAction`, auto-routed at `POST /api/chat/chat-confirm-action`) takes `{ actionId, capabilityName, schemaHash, execute }`. The client gets all three (action ID, capability name, schema hash) from the `confirmation_required` event the runtime emitted when the action was proposed. On confirm the capability:

1. Loads the pending action.
2. **Re-hashes the capability's current input schema and compares to the supplied `schemaHash`** — if the schema has changed since the action was proposed (e.g. a redeploy tightened it), rejects with `chat.action_schema_changed`.
3. Re-validates input against the current schema.
4. Executes the capability via the standard `executeCapability` path.
5. Marks the action `confirmed`.

This `schemaHash` check is the security primitive: it guarantees that what the user confirmed is exactly what gets executed. The client carries `schemaHash` purely as a witness — the server is the only party that re-derives it from the live schema.

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
