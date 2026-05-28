# Policies & Guards — Agent Recipe

The `policy` block compiles into an ordered pipeline of guards. Built-in guards cover most needs. Reach for `policy.custom` only when nothing built-in fits.

## Guard Pipeline (FIXED order — do not try to reorder)

```
preTurn:   audience → locale → behavioral → custom
                                                 ↓
                                  context resolution
                                                 ↓
                                          model call
                                                 ↓
postTurn:  provenance → scope → privacy → action → behavioral (postflight) → customPostTurn
```

Each guard returns one of three verdicts:

```ts
type GuardVerdict =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string; emit?: Partial<ChatEvent> }
  | { decision: 'require_confirmation'; pendingAction: PendingAction };
```

## Built-in Guards — Quick Reference

| Guard | When it fires | Config slot | Typical use |
|---|---|---|---|
| `audience-guard` | pre-turn | `policy.audience` | Block wrong-role callers |
| `locale-guard` | pre-turn | `policy.scope.locales` + `policy.reply.locale` | Reject unsupported locales |
| `behavioral-guard` | pre + post | `policy.behavioral.cooldowns` | Abuse pattern cooldowns |
| `scope-classifier` | post-turn | `policy.scope.description` | Refuse out-of-scope questions |
| `privacy-guard` | post-turn | `policy.privacy.redact` | Strip PII tokens from answer (substring only) |
| `provenance-guard` | post-turn | `policy.provenance.required` | Require valid citations |
| `action-guard` | post-turn | `policy.action.allowedCapabilities` | Capability writes with confirmation |

## Recipe: configure a guard

### Audience (multi-role)

```ts
policy: {
  audience: {
    roles: ['user', 'admin'],
    mode: 'strict',                          // default; missing role → block
    // mode: 'permissive', default: 'user', // for hybrid public/auth chats
  },
}
```

### Scope (off-topic refusal)

```ts
policy: {
  scope: {
    description: 'Help with billing only. The caller is asking about their own account.',
    // classifier: 'inline' is implicit; 'custom' is accepted but behaves identically
    locales: ['en', 'he'],                   // optional whitelist
  },
}
```

The model returns `inScope: boolean` in its structured output. The runtime trusts it and routes refusals through localized notice copy.

### Behavioral (refusal cooldown)

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

State persists on `ChatSession.behavioralState`. Atomic counter updates handle concurrent turns.

### Action (capability write with confirmation)

```ts
actions: ['openSupportTicket', 'updateBillingPlan'],
policy: {
  action: {
    allowedCapabilities: ['openSupportTicket', 'updateBillingPlan'],
  },
},
```

When the model returns `requestedAction`, the action-guard:
1. Validates `capabilityName` is in `allowedCapabilities` (deny by default).
2. Re-validates `input` against the capability's current Zod schema.
3. Hashes the schema and stores a `ChatPendingAction` row.
4. Returns `require_confirmation` — runtime emits `confirmation_required` with `{ actionId, capabilityName, confirmationMessage, expiresAt, schemaHash }`. The `schemaHash` on the wire is what the client must echo back.

**Confirmation is a server capability, not a UI helper.** The client commits the action by calling the auto-routed `chatConfirmAction` capability (`POST /api/chat/chat-confirm-action`) with `{ actionId, capabilityName, schemaHash, execute: true }`. On the server: schema is re-hashed; if it has changed since propose (e.g. a redeploy tightened it), the call is rejected with `chat.action_schema_changed`. This `schemaHash` check is load-bearing security — do not bypass it and do not let the client forge a hash, since the server re-derives from the live schema.

In `@plumbus/chat-ui`, `useChat.confirm()` is a UI-only stub that clears local `pendingConfirmation` state but does **not** call `chatConfirmAction`. Apps that ship action-confirmation flows must call the capability directly.

### Provenance (require citations)

```ts
policy: {
  provenance: { required: true, minSources: 1 },
}
```

Model's `citedSources: string[]` is validated against the runtime-issued handles. Invalid IDs are stripped from the answer. If `required: true` and zero valid citations remain, the guard blocks with `notice: chat.provenance_missing`.

## Custom Guards

Use custom guards only when nothing built-in fits. Two slots, both `Guard[]`, differing only in **when** they run:

- **`policy.custom`** — pre-turn (after the pre-turn built-ins, **before the model call**). Sees `turnCtx` (incl. `userMessage`) and `state` (`policy`, `ctx`, `resolvedSources`, `clientHistory`) but NOT `state.modelOutput`. For input gating: a `block` ends the turn before any tokens are spent.
- **`policy.customPostTurn`** — post-turn (after all built-ins), with `state.modelOutput` available. For output moderation. NOTE: a post-turn `block` emits its notice but does **not** suppress the answer — to redact/replace output, mutate `state.modelOutput.answer` (same contract as the built-in `privacy`/`scope` guards).

```ts
import type { Guard } from '@plumbus/chat';

// Pre-turn: gate the incoming message. state.modelOutput is undefined here.
const blockBannedTerms: Guard = async (turnCtx, _state) => {
  if (turnCtx.userMessage && containsBannedTerm(turnCtx.userMessage)) {
    return {
      decision: 'block',
      reason: 'my.banned_term',
      emit: { type: 'notice', code: 'my.banned_term', message: 'Content blocked.' },
    };
  }
  return { decision: 'allow' };
};

// Post-turn: redact the model's answer (mutate it — a `block` won't suppress it).
const redactSecrets: Guard = async (_turnCtx, state) => {
  if (state.modelOutput && typeof state.modelOutput.answer === 'string') {
    state.modelOutput.answer = state.modelOutput.answer.replace(/\bsk-[a-z0-9]+\b/gi, '[redacted]');
  }
  return { decision: 'allow' };
};

defineChat({
  policy: { custom: [blockBannedTerms], customPostTurn: [redactSecrets] },
});
```

## Do's

- **Do** layer multiple built-in guards — they compose. A chat can have audience + behavioral + scope + provenance simultaneously.
- **Do** include a non-empty `policy.audience.roles` when `mode: 'strict'` (the default). Empty roles in strict mode is a `defineChat` validation error.
- **Do** treat `policy.scope.description` as a short, declarative scope statement — not a long persona description (that belongs in `instructions:`).
- **Do** set `policy.behavioral.cooldowns` on any chat that gets exposed to anonymous users — abuse prevention.

## Don'ts

- **Don't** try to reorder the guard pipeline. The order is fixed; `policy.custom` runs at the end of pre-turn, `policy.customPostTurn` at the end of post-turn.
- **Don't** put PII detection logic in a custom guard if you can express it via `policy.privacy.redact` (even though redaction is substring-only, it's the right slot for future upgrades).
- **Don't** bypass the action-guard for writes. Configure `policy.action.allowedCapabilities` and let the framework re-validate + confirm.
- **Don't** read `state.modelOutput` in a `policy.custom` (pre-turn) guard — it's `undefined` until the model runs. To act on the model's answer, use `policy.customPostTurn`.
- **Don't** expect a post-turn `block` to suppress the answer. In `policy.customPostTurn`, mutate `state.modelOutput.answer` to redact/replace; `block` only emits the notice.

## Deeper Reference

- `/docs/chat/policies.md` — full conceptual reference
- `/docs/chat/design/scope-via-structured-output.md` — why scope is post-turn, not preflight
- `/docs/chat/design/behavioral-cooldowns.md` — when cooldowns fit (vs. budgets, vs. guards)
- `/docs/chat/design/session-entities.md` — the `schemaHash` security mechanism
- `src/policy/registry.ts` — the `compilePolicy` function that orders guards
- `src/policy/*.ts` — each built-in guard's implementation
