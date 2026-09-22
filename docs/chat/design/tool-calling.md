# Provider-native tool calling in chat

> Status: **Locked**

## The problem

`@plumbus/chat` shipped with one write path: the model returns a `requestedAction`
object, the post-turn `action-guard` re-validates it, and the runtime emits
`confirmation_required`. That path (now called **Path A**) has two gaps:

1. **It is single-shot.** The model proposes exactly one action per turn as a side
   field of the structured answer. It cannot call a capability, read the result, and
   decide what to do next inside the same turn.
2. **It never executed anything.** `chatConfirmAction` validated the pending row and
   returned a stub `{ executed: true }`; the app had to wire the real capability call
   itself. Users clicked "Confirm" and nothing happened server-side.

Meanwhile every mainstream provider exposes first-class tool calling (OpenAI
`tools`/`tool_calls`, Anthropic `tool_use`/`tool_result` + `input_schema`). Chat was
concatenating history into a single prompt and asking for a structured answer instead
of using the native protocol.

## How it works

Two paths now coexist. Neither breaks the other.

### Path A — legacy `requestedAction` (unchanged default)

`policy.action.allowedCapabilities` + `output.requestedAction` still work exactly as
before and remain **decision-only**. The optional field
`policy.action.frameworkExecuteOnConfirm` is **reserved and not yet enforced** in this
release — no code reads it, so setting it has no effect. Path A confirm records the
decision (driven by the confirm request's `execute` flag) without executing the target
capability through the framework.

### Path B — provider-native tool calling (new, opt-in)

Enabled by `policy.toolCalling: { enabled: true, ... }`. The runtime:

1. **Binds tools.** Each name in `policy.toolCalling.capabilities` is resolved via
   `ctx.__runtime.resolveCapability(name)` and turned into a provider `AITool`
   (`zodToProviderJsonSchema` on the capability input). Each name in
   `policy.toolCalling.autoStartFlows` is bound as a `flow__`-prefixed tool from its
   flow input schema. Every bound tool carries a `targetVersion` and a `toolBindingHash`
   (see [Binding hash](#binding-hash)).
2. **Runs a bounded loop.** The chat loop (default `maxToolRounds: 5`, range `1..20`)
   drives the provider through tool rounds using the registered `chat.toolRound` prompt.
   Chat **does not** call core's `runToolLoop` — core's loop has different defaults
   (`maxRounds` 8, hard cap 20) and is for capability authors, not chat.
3. **Executes auto-mode tools inline.** Auto tools call
   `executeCapability(cap, ctx, input)` from `@plumbus/core` — never
   `ctx.capabilities.invoke` (chat's allowlist is dynamic; `invoke` would throw
   `undeclaredInvocation`). `executeCapability` still runs `evaluateAccess(cap.access,
   ctx.auth)`, so access policy is enforced.
4. **Pauses confirm-mode tools.** A confirm-mode tool call is **normalized before
   confirm** (resolve contract, require `argumentsStatus === 'parsed'`, validate with the
   capability's Zod input validator, apply defaults/coercions) and only the normalized
   value is stored as `pending.input`. The runtime persists a durable
   `ChatPendingActionV2` (with the full `resumePayload`) and emits `confirmation_required`.
   Invalid arguments never create a pending row — the loop records one safe
   `chat.tool_arguments_invalid` observation and continues.
5. **Resumes on confirm.** `POST /chat/:name/confirm` claims the pending row atomically,
   executes the tool through the capability pipeline, then **resumes the turn for a single
   answer-only completion (no further tool rounds or nested confirmation)** from the saved
   `resumePayload`. Path B is **always framework-invoke + resume** — there is no
   decision-only mode for Path B.

### Agent orchestration (additive refinement)

The original staged Path B remains the default for guarded support assistants. Domain conversations can opt into `toolCalling.orchestration: 'agent'`: their custom plain-text prompt is itself the bounded provider tool loop. A tool-less completion is the final answer, while a tool call continues that same prompt after execution. `scopePreflight` defaults off in this mode, eliminating the unconditional scope classifier and separate answer composer. This is deliberately restricted to custom prompts; chats that require inline scope, provenance, or structured action fields should remain staged.

### Round-limit terminal (C7)

At `maxToolRounds` the runtime makes **one** final model request that **omits both
`tools` and `toolChoice`** (never `toolChoice: 'none'`), then produces the answer. It
emits `chat.tool_round_limit` as a **non-fatal** `notice`/audit code — the turn still
completes.

### Storage (lease-based)

Path B requires a transaction-capable / conditional-write store. `ChatConversationStore`
(`acquireSessionMutation` + `commitProposal` + `claimPending` + `completePending`, all
under a session lease) makes the propose and the confirm+resume atomic. `ChatTurn` uses a
**unique** `(sessionId, ordinal)` index (`EntityIndexDefinition.unique`). An adapter that
cannot provide a conditional/transactional write path **fails closed at startup** with
`chat.storage_unsupported`.

### Confirm auth (C7 / D3)

`POST /chat/:name/confirm` reuses `/turn` authentication via the injected
`ChatRequestAuthenticator` (Authorization-header credentials take precedence over
cookies). When the credential source is a cookie, the runtime additionally enforces an
**exact-Origin** check and a **session-bound CSRF token**; a mismatch is
`chat.origin_invalid`.

### Binding hash

`toolBindingHash` folds the allowlist entry, `mode`, effects, `inputSchemaHash`, and
`targetVersion` into one value. Capability `targetVersion` comes from
`CapabilityContract.version` when present, else the input-schema-hash **fallback**; flow
`targetVersion` is the flow input-schema hash. The hash is re-verified at confirm time —
if the live binding no longer matches the proposal, confirm fails with
`chat.binding_changed`.

## Prompt registration (D5)

Staged Path B uses two package-shipped prompts in addition to `chat.turn`:
`chatToolRoundPrompt` (`chat.toolRound`) and `chatScopeCheckPrompt` (`chat.scopeCheck`).
Plumbus registers prompts by **`app/prompts/*.prompt.ts` directory discovery**, so the app
must **re-export** these two into `app/prompts/` (the same one-time wiring already used for
`chat.turn` and the chat entities). There is no `registerChatToolCallingPrompts()` helper.
A startup check fails staged Path B with `chat.prompt_not_registered` when either name is absent
from `ctx.ai`'s registry, before any provider I/O. Agent orchestration without scope preflight uses only its custom prompt.

## Error vocabulary and HTTP status

The full `chat.*` error table and the HTTP status mapping (400 schema / 401 auth /
403 access+origin / 404 owner-miss / 409 busy·pending·stale·binding-changed·already-claimed
/ 410 expired / SSE-terminal for post-confirm resume failure; `409` body is
`{ code, actionId, expiresAt }`) live in
[`docs/chat/policies.md`](../policies.md#tool-calling-path-b) and are the normative source.

## Existing-pending rule (C5)

`/turn` checks the live pending action **before** any scope/provider work: an existing
`pending` action → `409 chat.pending_action_exists`; an in-flight `confirming` action →
`409 chat.session_busy`; an expired pending is atomically terminalized, then the turn
proceeds. The `409` body carries `{ code, actionId, expiresAt }`.

## Tradeoffs

- **Two paths is deliberate.** Path A stays for apps that only ever propose one action and
  want a decision record; Path B is for genuine tool-using assistants. Migrating A→B is a
  policy change, not a rewrite.
- **Path B needs a real store.** The in-memory / non-transactional adapters cannot run it;
  that is a startup failure, not a silent degrade.
- **Budgets are cumulative across the confirm boundary.** The `resumePayload.counters`
  carry rounds/flow-starts/tokens/cost forward; resume never resets a budget.

## Followup

- Multi-tool parallel execution is disabled (`toolExecution.parallelToolCalls: false`) for
  chat rounds; revisit only with per-tool idempotency guarantees.
- **Resume is answer-only.** The post-confirm resume makes exactly one completion and never
  runs further tool rounds or raises a nested `confirmation_required`. A confirmed action
  that would need another tool call cannot chain it inside the same turn — the model gets
  the tool result and must answer.
- `useChat.confirm()` now performs the real `/confirm` round-trip (see
  [`docs/chat-ui/README.md`](../../chat-ui/README.md)); the historical UI-only stub is gone.
