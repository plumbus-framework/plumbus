# Chat design decisions

Why the chat framework is shaped the way it is. Eleven records covering the load-bearing decisions made while building it.

Read these before "fixing" something that looks weird. They explain tradeoffs, rejected alternatives, and what to watch out for when extending the runtime.

## Index

### Runtime behavior
- [Scope enforcement: single-call structured output](./scope-via-structured-output.md) — why we trust the model's `inScope` boolean instead of running a preflight classifier
- [Audience as a first-class policy slot](./audience-policy.md) — multi-audience help-bots without two codebases
- [Locale required on every turn](./locale-everywhere.md) — how language threads through context, prompt, guards, notices
- [Provider-native tool calling](./tool-calling.md) — Path A (`requestedAction`) vs Path B (`policy.toolCalling`), the lease-based store, confirm+resume, and why chat does not call core's `runToolLoop`

### Stateful enforcement
- [Behavioral cooldowns](./behavioral-cooldowns.md) — when budgets and guards aren't enough
- [In-session summarization](./in-session-summarization.md) — opt-in compression for long conversations

### Data model
- [Session entities + schema-hash on pending actions](./session-entities.md) — why ChatSession/ChatTurn/ChatPendingAction live in the package
- [Server vs client message persistence](./message-persistence-modes.md) — privacy opt-out without losing abuse metadata

### Context and prompts
- [Static context helpers](./static-context-helpers.md) — closing the gap between RAG and live capabilities
- [Per-chat prompt override](./per-chat-prompts.md) — when the generic `chat.turn` prompt isn't enough
- [Corpus argument landed in `@plumbus/core`](./corpus-arg-in-core.md) — the multi-corpus prerequisite

## How to read them

Each doc has the same shape:

```
# <Descriptive title>

> Status: **Locked** (or similar)

## The problem
What forced the decision. What was unsatisfying about the alternatives.

## How it works
The chosen mechanism, briefly.

## Tradeoffs
What works well, what you give up, what to watch out for.

## Followup (if any)
Things this leaves undone (e.g. PR to sync the public spec).
```

If you're considering a change that contradicts one of these, the right move is usually to write an addendum (`-v2.md`) explaining what changed and why, not to silently revise the original.
