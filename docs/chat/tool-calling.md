# Tool calling (Path B)

A chat with `policy.toolCalling.enabled: true` lets the model call your capabilities directly through provider-native tool calling, instead of proposing a single `requestedAction`. This is **Path B**. Chats without `toolCalling` (or with `enabled: false`) keep the single-shot **Path A** behavior unchanged.

## What runs, in order

1. **Prompt-registration check.** `chat.scopeCheck` and `chat.toolRound` must be registered. If either is missing, the turn fails with `chat.prompt_not_registered` before any provider call.
2. **Scope preflight** (`chat.scopeCheck`, temperature 0). Off-topic / unsafe messages refuse here before any tool round is spent.
3. **Tool phase** (`chat.toolRound`). Bounded rounds (`maxToolRounds`, default 5). The model calls auto/read capabilities; the runtime executes each through the framework capability pipeline (access policy enforced) and feeds results back. Round limit is a non-fatal `chat.tool_round_limit` notice.
4. **Answer phase** (`chat.turn`, tools omitted). Composes the final user-facing answer, grounded in the tool results.

## Which capabilities become auto tools

A capability is an **auto/read** tool when its only effect is `ai: true` (all of `data`, `events`, `external`, `flows`, `capabilities` empty). Any write/side-effect makes it a **confirm** tool. Confirm-mode tools are bound but not executed by this path.

## Confirm and resume

A confirm-mode tool pauses the turn with a `confirmation_required` event. The client commits with `POST /chat/:name/confirm`; the server executes the confirmed capability through the framework pipeline (deny-by-default access preserved), then **resumes the turn for a single answer-only completion — no further tool rounds and no nested confirmation**. See [policies.md → Tool calling (Path B)](./policies.md#tool-calling-path-b) for the full confirm round-trip, error vocabulary, and HTTP status mapping.

## Required one-time app setup (D5)

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

If `toolCalling.enabled` is set but no `chatRegistry` is wired, the first Path B turn fails with `chat.prompt_not_registered` (a per-turn `turn.failed`, not a boot-time error).

## Config

`policy.toolCalling`:

| Field | Default | Range |
|---|---|---|
| `enabled` | — | required boolean |
| `capabilities` | `[]` | canonical capability names to expose |
| `autoStartFlows` | `[]` | flow names bound as `flow__<name>` tools |
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
