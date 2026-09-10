# Tool calling (Path B)

A chat with `policy.toolCalling.enabled: true` lets the model call your capabilities directly through provider-native tool calling, instead of proposing a single `requestedAction`. This is **Path B**. Chats without `toolCalling` (or with `enabled: false`) keep the single-shot **Path A** behavior unchanged.

## Orchestration modes

`toolCalling.orchestration` is additive and defaults to `staged`.

### `staged` (default)

Runs, in order:

1. **Prompt-registration check.** `chat.scopeCheck` and `chat.toolRound` must be registered. If either is missing, the turn fails with `chat.prompt_not_registered` before any provider call.
2. **Scope preflight** (`chat.scopeCheck`, temperature 0). Off-topic / unsafe messages refuse here before any tool round is spent.
3. **Tool phase** (`chat.toolRound`). Bounded rounds (`maxToolRounds`, default 5). The model calls auto/read capabilities; the runtime executes each through the framework capability pipeline (access policy enforced) and feeds results back. Round limit is a non-fatal `chat.tool_round_limit` notice.
4. **Answer phase** (`chat.turn`, tools omitted). Composes the final user-facing answer, grounded in the tool results.

### `agent`

Requires a custom plain-text chat prompt. The runtime attaches the configured tools directly to that prompt:

1. The custom agent prompt receives server-owned prompt input and native history.
2. If it answers without a tool, that first completion is the final answer: one model call.
3. If it calls an auto tool, Chat executes the capability through `executeCapability`, appends the native observation, and continues the same prompt.
4. At the round limit, one terminal request omits tools and must answer with the observations already gathered.

`scopePreflight` defaults to `false` in agent mode and may be enabled explicitly. With it disabled, agent mode does not use `chat.scopeCheck` or `chat.toolRound`, and therefore needs no package-prompt re-export or `ChatRegistry`. This mode synthesizes `inScope:true`, empty citations, and no requested action around the plain-text answer; use staged mode for scope/provenance-driven support chats.

Provider-native tool selection uses `generateWithUsage`, so the final plain-text answer is emitted as one `message.delta` after the tool loop completes. It is event-streamed but not token-streamed; consumers that animate reading pace can do so from that completed delta.

Tool-enabled rounds inherit prompt/runtime provider, model, and reasoning configuration. `policy.toolCalling.ai` can override each field; `reasoning:null` restores provider default and clears inherited new or legacy reasoning controls. Reasoning is expressed as provider-neutral `disabled`, `effort`, or token `budget` intent and translated by core's selected adapter. Chat contains no provider wire-format or model-name compatibility branch.

The optional `toolCalling.ai` override requires core ≥ 0.6.18. Older cores receive a structured `turn.failed` event with code `chat.core_version_unsupported`. Chats that omit it keep Chat's previous core ≥ 0.6.11 runtime floor.

Programmatic callers that need per-operation billing attribution can pass `RunChatTurnOpts.onNestedAiCall`. It observes each successful `generateWithUsage` or `streamGenerate` call inside an auto capability tool, including its capability name, prompt, provider/model, usage, cost, and `includedInTurnUsage` flag. This is a server-only callback: nested usage remains part of the logical Chat turn and its budget total when that flag is true, so callers can split ledger rows without weakening enforcement.

## Which capabilities become auto tools

A capability is an **auto/read** tool when its only effect is `ai: true` (all of `data`, `events`, `external`, `flows`, `capabilities` empty). Any write/side-effect makes it a **confirm** tool. Confirm-mode tools are bound but not executed by this path.

## Confirm and resume

A confirm-mode tool pauses the turn with a `confirmation_required` event. The client commits with `POST /chat/:name/confirm`; the server executes the confirmed capability through the framework pipeline (deny-by-default access preserved), then **resumes the turn for a single answer-only completion — no further tool rounds and no nested confirmation**. See [policies.md → Tool calling (Path B)](./policies.md#tool-calling-path-b) for the full confirm round-trip, error vocabulary, and HTTP status mapping.

## Required staged-mode app setup (D5)

Package prompts are not auto-registered. Re-export the two tool-calling prompts into your `app/prompts/` directory so directory discovery registers them (the same setup as the chat entities and `chat.turn`):

```ts
// app/prompts/chat-tool-calling.prompt.ts
export { chatToolRoundPrompt, chatScopeCheckPrompt } from '@plumbus/chat';
```

Then give `registerChatRoutes` a `ChatRegistry` built from the same `PromptRegistry` your AI service uses:

```ts
import { registerChatRoutes, createChatRegistry } from '@plumbus/chat';

registerChatRoutes(app, routeConfig, chats, {
  chatRegistry: createChatRegistry(promptRegistry),
});
```

If staged tool calling (or agent mode with scope preflight) is set but no matching `chatRegistry` is wired, the first turn fails with `chat.prompt_not_registered` (a per-turn `turn.failed`, not a boot-time error). Agent mode with `scopePreflight:false` has no package-prompt registration dependency.

## Config

`policy.toolCalling`:

| Field | Default | Range |
|---|---|---|
| `enabled` | — | required boolean |
| `capabilities` | `[]` | canonical capability names to expose |
| `autoStartFlows` | `[]` | flow names bound as `flow__<name>` tools |
| `ai.model` | prompt/runtime config | non-empty model id |
| `ai.provider` | prompt/runtime config | Name of a configured core provider adapter |
| `ai.reasoning` | prompt/runtime config | `null`, `{mode:'disabled'}`, `{mode:'effort', effort}`, or `{mode:'budget', maxTokens}` |
| `includeNestedAiUsage` | staged: `false`; agent: `true` | Include AI calls inside auto tools in logical-turn usage/budgets |
| `orchestration` | `staged` | `staged` \| `agent` |
| `scopePreflight` | staged: `true`; agent: `false` | boolean |
| `maxToolRounds` | 5 | 1..20 |
| `maxTools` | 32 | 1..64 |
| `flowAwaitMs` | 10000 | per-start await ceiling, ms |
| `flowPollIntervalMs` | 250 | flow status poll interval, ms |
| `flowAwaitBudgetMsPerTurn` | 15000 | cumulative await budget/turn, ms; `0` disables polling |
| `maxFlowStartsPerTurn` | 2 | 0..20 |
| `confirmationTtlMs` | 900000 | pending-action TTL, ms (15 min default) |

`policy.toolCalling` cannot be combined with the legacy action allowlist (`actions` / `policy.action.allowedCapabilities`), and requires `persistence.saveToDb: true`.

## Events

Path B adds `tool.started`, `tool.completed`, and `tool.failed` to the event stream. A confirm-mode tool additionally emits `confirmation_required` when it pauses and `confirmation.resolved` once the confirm round-trip records a decision. Each executed tool is also recorded on the assistant `ChatTurn` row under `toolsExecuted`.

## Programmatic domain chats

`runChatTurn` additionally accepts server-only `promptInput`, `trustedHistory`, and `signal`. These fields are never copied from arbitrary HTTP request properties. When called from inside a capability—where core intentionally hides the dynamic runtime resolver—pass `opts.resolveCapability`; Chat retains the returned contract only for that in-process turn and still executes it through the full capability pipeline.

AI usage/cost returned by `generateWithUsage` or `streamGenerate` inside an auto capability tool is folded into the logical turn totals. This keeps per-turn budgets and consumer cost attribution honest for AI-only helper tools.
