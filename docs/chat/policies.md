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

**`chatConfirmAction` (Path A) is decision-only in this release.** A confirmed Path-A action validates, marks the pending row confirmed, emits domain events, and returns without executing the target capability through the framework; the outcome is driven by the confirm request's `execute` flag (`execute: true` records a confirm, `false` a decline). `policy.action.frameworkExecuteOnConfirm` is **reserved and not yet enforced** — no code reads it, so setting it has no effect in this release. Provider-native tool calling (Path B, below) always executes on confirm and resumes the turn for a single answer-only completion (no further tool rounds or nested confirmation).

This `schemaHash` check is still load-bearing: it guarantees the user confirmed against the schema that was live at propose time. The client carries `schemaHash` as a witness — the server re-derives v2 hashes from the live schema.

> **UI wiring.** `useChat`'s `confirm(actionId)` in `@plumbus/chat-ui` performs the real `POST /chat/:name/confirm` round-trip (it also exposes `decline` and `lastConfirmResult`). Apps no longer hand-wire the confirm call; see [`packages/chat-ui/src/hooks/useChat.ts`](../../packages/chat-ui/src/hooks/useChat.ts) and [chat-ui docs](../chat-ui/README.md).

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

## Tool calling (Path B)

`policy.toolCalling` is the provider-native tool-calling path (see
[defining-chats.md → Provider-native tool calling](./defining-chats.md#provider-native-tool-calling-policytoolcalling-path-b) for the config shape). This section is the normative source for its error vocabulary and HTTP status mapping.

Two orchestration modes share the same binding, execution, event, budget, and confirmation machinery. `staged` is the backward-compatible default (`scopeCheck` → `toolRound` → structured answer). `agent` requires a custom plain-text prompt and makes that prompt the tool loop and final answer; `scopePreflight` defaults off, so an ordinary in-domain turn is one call and an auto tool runs only when the agent requests it.

The tool-using AI inherits its prompt/runtime provider, model, and reasoning configuration by default. `policy.toolCalling.ai` may override all three for tool rounds and resume. Reasoning uses core's provider-neutral `disabled`, `effort`, or token `budget` contract; `null` restores provider default. The selected core adapter performs wire translation and rejects unsupported modes without model-name heuristics in Chat.

`policy.toolCalling.includeNestedAiUsage` controls whether `ctx.ai.generateWithUsage` / `streamGenerate` calls made inside auto tools are added to the logical Chat turn's usage and budget. It defaults to `false` for staged orchestration, preserving 0.1.11 behavior, and `true` for the new agent orchestration.

### Confirm round-trip

Confirm-mode tools pause the turn with `confirmation_required` (which now also carries an
optional `inputSchemaHash` and a validated `projection`). The client commits with
`POST /chat/:name/confirm`. That endpoint:

1. Authenticates via the same `ChatRequestAuthenticator` as `/turn` (Authorization header
   beats cookie). Cookie-authenticated writes additionally require an exact-Origin match
   and a session-bound CSRF token, else `chat.origin_invalid`.
2. Atomically **claims** the pending row (owner + chatName + `inputSchemaHash` +
   `toolBindingHash` + expiry + `status === 'pending'` + session revision), flipping it
   `pending → confirming`.
3. Executes the tool through the capability pipeline (`executeCapability`, access enforced).
4. **Resumes** the turn for a single answer-only completion (no further tool rounds or
   nested confirmation), then persists the terminal turn.

`/turn` checks the live pending action **before** any scope/provider work: an existing
`pending` action → `chat.pending_action_exists`; an in-flight `confirming` action →
`chat.session_busy`; an expired `pending` or a `confirming` row whose resume session
lease has expired (and claim grace elapsed) is atomically terminalized (`expired` or
`failed`) then the turn proceeds. Pending rows are read before the session lease; when
`executionStartedAt` is set but the first lease read is inactive, the lease is re-read
once before reaping, and the reap CAS is scoped to `{ status: 'confirming', attemptId }`.

### Error codes

| Code | Meaning |
|---|---|
| `chat.tool_calling_disabled` | Tool endpoint/operation used while tool calling is disabled. |
| `chat.tools_runtime_unavailable` | `ctx.__runtime.resolveCapability` unavailable at bind time. |
| `chat.tools_flows_unavailable` | Flow describe/execution service unavailable. |
| `chat.tool_unknown_capability` | Configured capability cannot be resolved. |
| `chat.tool_unknown_flow` | Configured flow cannot be described. |
| `chat.tool_flow_schema_invalid` | Flow input schema cannot be exposed as a provider tool. |
| `chat.tool_name_invalid` | Bound name violates the portable grammar or reserved `flow__` prefix. |
| `chat.tool_not_bound` | Provider requested a tool name absent from the bound set. |
| `chat.tool_arguments_invalid` | Provider arguments could not be parsed, or normalize-before-confirm validation failed. |
| `chat.tool_access_denied` | `evaluateAccess` denied capability execution. |
| `chat.tool_failed` | Capability failed with a safe known error. |
| `chat.tool_not_executed_confirmation_boundary` | A later batch call was suppressed after a confirmation pause. |
| `chat.tool_round_limit` | Tool round limit reached — **non-fatal** notice/audit code. |
| `chat.flow_start_budget_exceeded` | `maxFlowStartsPerTurn` exhausted. |
| `chat.flow_await_budget_exceeded` | `flowAwaitBudgetMsPerTurn` exhausted. |
| `chat.prompt_not_registered` | `chat.toolRound` or `chat.scopeCheck` absent from the prompt registry; Path B fails before provider I/O. |
| `chat.pending_action_exists` | A live `pending` action already exists for the session. |
| `chat.session_busy` | Another turn/confirm mutation owns the session lease, or a `confirming` action is in flight. |
| `chat.storage_unsupported` | Store adapter lacks the transactional/conditional-write path; startup fail-closed. Also raised when a chat that can request confirmations runs on an injected `sessionStore` with no `conversationStore` — see [session-store.md](./session-store.md). |
| `chat.budget_unsupported` | A chat declares a `budget` (or `budget.actions.perSession`) but the injected session store cannot aggregate the stored turns needed to **enforce** it. Fail-closed, so a cap is never silently unenforced. Concerns cap enforcement only — AI cost recording (`onAICostRecorded`, the cost ledger) is core's and is unaffected. Unreachable unless a `sessionStore` is injected. |
| `chat.turn_aborted` | Request disconnect or timeout aborted the turn. |
| `chat.action_not_found` | Pending action does not exist for the authenticated owner. |
| `chat.action_expired` | Pending action expired before claim. |
| `chat.action_already_claimed` | Pending action is not claimable (lost the atomic claim). |
| `chat.confirm_stale` | Session revision changed after the proposal. |
| `chat.binding_changed` | Current binding no longer matches the proposal (allowlist/version/schema/mode/effects). |
| `chat.origin_invalid` | Cookie-authenticated write failed exact-Origin validation. |
| `chat.resume_payload_invalid` | Resume payload malformed, unsupported version, or oversized. |
| `chat.resume_failed` | Capability succeeded but chat continuation failed; no re-execution. |

### HTTP status mapping

Errors detected **before** the SSE stream opens map to a status code; errors after stream
start are emitted as a terminal `turn.failed` SSE event (SSE-terminal). The `409` body is
`{ code, actionId, expiresAt }`.

| HTTP status | Codes |
|---|---|
| `400 Bad Request` | request-body schema invalid; `chat.tool_calling_disabled`; `chat.resume_payload_invalid` |
| `401 Unauthorized` | authenticator failure (no/invalid credential) |
| `403 Forbidden` | `chat.tool_access_denied`; `chat.origin_invalid` |
| `404 Not Found` | `chat.action_not_found` (owner-miss) |
| `409 Conflict` | `chat.session_busy`; `chat.pending_action_exists`; `chat.confirm_stale`; `chat.binding_changed`; `chat.action_already_claimed` |
| `410 Gone` | `chat.action_expired` |
| SSE-terminal (`turn.failed` event) | `chat.resume_failed` (post-confirm resume failure); `chat.turn_aborted`; `chat.tool_failed`; and `chat.tool_round_limit` as a non-fatal `notice` |

## Flow tools (`toolCalling.autoStartFlows`) and the confirm/auto asymmetry

When tool calling is enabled, two kinds of things can be exposed to the model as
provider tools, and they resolve to **different confirmation modes on purpose**:

- **Capabilities** (`toolCalling.capabilities`). A capability that carries write
  effects — non-empty `effects.data`, `effects.events`, `effects.external`, or a
  non-empty `effects.flows` — is bound in **confirm** mode: the model proposes the
  call, the runtime pauses with a `confirmation_required` event, and the action
  only executes after the user confirms.
- **Flows** (`toolCalling.autoStartFlows`). A flow listed here is bound as a tool
  named `flow__<flowName>` in **auto** mode: when the model selects it, the runtime
  starts the flow immediately (no confirmation step) and briefly polls for a
  terminal status within the turn's await budget.

**Why the asymmetry is intentional.** `effects.flows` on a *capability* means the
capability itself performs side-effecting work, so it inherits the same
confirm-gated treatment as any other write capability. `autoStartFlows`, by
contrast, is an explicit allowlist the app author opts into specifically so the
model may start those flows directly — listing a flow there is the author's
pre-authorization. Only put flows in `autoStartFlows` that are safe to start
without per-turn user confirmation.

**Turn budgets.** Flow tool calls are bounded per turn by
`maxFlowStartsPerTurn` (default 2) and the cumulative `flowAwaitBudgetMsPerTurn`
(default 15 000 ms; `0` disables in-turn polling so a started flow is reported as
`in_progress`). Each individual start additionally waits at most `flowAwaitMs`
(default 10 000 ms), polling every `flowPollIntervalMs` (default 250 ms). A flow
that has not reached a terminal status when the budget elapses is reported as
`in_progress` — never `completed` — and continues running in the background.

**Requirements.** Flow tools require a flow registry wired into `ctx.flows`
(so `ctx.flows.describe()` is available); the HTTP server and MCP serve contexts
supply it. A flow whose input schema cannot be represented as a provider tool
schema is rejected at bind time (`chat.tool_flow_schema_invalid`), and flow names
longer than 57 characters (or containing characters outside `[A-Za-z0-9_-]`) are
rejected as `chat.tool_name_invalid`.
