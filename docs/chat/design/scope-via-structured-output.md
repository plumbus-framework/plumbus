# Scope enforcement: single-call structured output

> **Locked.** Inline classifier — no preflight LLM call.

## The problem

`policy.scope.description` declares what a chat is allowed to answer about, but the description alone doesn't enforce anything — the runtime needs a mechanism to act on it. Three options were on the table:

1. **Preflight LLM classifier** — call a small model to decide in-scope vs out-of-scope before the main generation. Strong guard, but every turn — including in-scope ones — pays the cost.
2. **Inline structured-output classifier** — bake `{ inScope, answer, refusalReason }` into the main generation's output schema. The model classifies and answers in one call. The runtime trusts the boolean and post-processes refusals.
3. **System-prompt guidance + regex post-check** — soft, fragile, easy to jailbreak.

Option 2 has been used in production help-bots for months with acceptable refusal accuracy. Most production help-chats converge to the same pattern once they hit cost concerns.

## How it works

The generic `chat.turn` prompt's output schema includes:

```ts
{
  inScope: z.boolean(),
  answer: z.string(),
  refusalReason: z.enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request']).nullable(),
  citedSources: z.array(z.string()),
  requestedAction: z.unknown().nullable(),
}
```

The model returns the boolean alongside its answer. The post-turn `scope-classifier` guard reads `inScope`; when false, it replaces `answer` with localized refusal copy and emits `notice: chat.out_of_scope`. No separate LLM call.

Configurable via `policy.scope.classifier: 'inline' | 'custom'`. Only the inline path is implemented — `'custom'` is accepted by the schema but currently behaves identically to `'inline'`. It exists as an escape hatch for consumers with very high refusal rates (where a preflight classifier starts to pay off).

## Tradeoffs

**What works well:**
- One LLM round-trip per turn. Latency and cost are identical to a non-scope-guarded chat on in-scope traffic.
- `inScope` is a deterministic field in the trace — the eval framework can assert on it cleanly.
- Matches a proven pattern from real production help-bots.

**What you give up:**
- Out-of-scope turns spend generation tokens. The model produces an empty `answer` + a `refusalReason`, but you still pay for the call. Empirically cheaper than preflight because most turns are in-scope; consumers whose refusal rate climbs above ~30% are the case a custom classifier path would serve.
- The runtime trusts the model's self-classification. A determined adversarial user can probably get the model to mis-classify. This is acceptable for help-style chats; not acceptable for chats where scope violation has security implications — use a custom guard there.
- Every chat prompt must include the five required output fields. Per-chat custom prompts (see [per-chat-prompts.md](./per-chat-prompts.md)) must keep them; `defineChat` does not reject narrowed schemas today (see that record's addendum).

