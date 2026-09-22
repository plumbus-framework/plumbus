# In-session summarization for long conversations

> **Locked.** Opt-in via `history.summarize`. Off by default.

## The problem

`history.includeLastTurns: N` works fine for short conversations but degrades as N is approached:

- A 50-turn conversation with `includeLastTurns: 8` silently drops everything before turn 42. The model loses earlier context with no signal.
- Increasing `includeLastTurns` linearly increases per-turn token cost.
- Long-term memory ("remember things from 3 sessions ago") is an explicit non-goal per the published spec.

What's needed is *in-session* summarization: when older turns fall off the window, compress them into a brief summary that gets injected alongside the window. Standard pattern in production chat systems.

## How it works

Opt-in via the history config:

```ts
history: {
  includeLastTurns: 8,
  summarize: {
    strategy: 'rolling' | 'threshold';
    thresholdTurns?: number;
    targetTokens?: number;
  };
}
```

When `history.summarize` is unset (default), summarization never runs — the package behaves identically without the slot.

When set, `maybeSummarize` runs after `loadHistoryWindow`:

- If `summaryTurnCount + history.length > thresholdTurns`, invoke the `chat.summarize.history` prompt with `previousSummary + olderTurns` as input.
- Result is written back to `ChatSession.summaryText` and prepended to the system prompt as `[Earlier conversation summary: …]`.
- `summaryTurnCount` advances by the number of turns folded in.

Two strategies:

- `'rolling'` — summarize on every turn once threshold is exceeded. Smoothest but most LLM calls.
- `'threshold'` — only summarize when the window slides off uncovered turns. Cheaper, slightly less smooth.

## Tradeoffs

**What works well:**
- Long conversations don't silently lose context. Earlier turns are still present, in compressed form.
- Off-by-default keeps short-conversation chats cheap.
- The summary lives on the session row; observable, auditable, regeneratable.

**What you give up:**
- Each summarization is an LLM call. Costs add up for long conversations under `'rolling'`.
- Summary quality is a model-quality concern that deterministic evals can't catch.
- The summarizer prompt is a single global prompt; not per-chat customizable. Consumers needing per-domain summarization style would need to register their own and override via `policy.custom` — clunky.

## Out of scope

- Cross-session memory — explicit framework non-goal.
- Entity-based long-term memory — separate concern, likely a future `@plumbus/memory` package.
- Per-chat custom summarizer prompts — add when demand appears.
