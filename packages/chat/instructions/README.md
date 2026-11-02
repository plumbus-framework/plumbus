# @plumbus/chat — Agent Instructions

This folder ships with the npm tarball and is the entry point for AI coding agents working in apps that depend on `@plumbus/chat`. Read these files in order when you need to add, modify, or extend a chat.

| File | When to read |
|---|---|
| [`framework.md`](./framework.md) | First. What the package is for, package conventions, file map, critical rules. |
| [`defining-chats.md`](./defining-chats.md) | When the user asks you to add a new chat. Step-by-step recipe + full config shape. Includes the *Enable provider-native tool calling (Path B)* recipe. |
| [`policies.md`](./policies.md) | When the user asks to add a guard, refusal cooldown, audience check, or action confirmation. Also tool calling (Path B) via `policy.toolCalling`. |
| [`context-sources.md`](./context-sources.md) | When wiring up `knowledgeContext` / `capabilityContext` / `staticContext`, or writing a custom one. |
| [`testing.md`](./testing.md) | When writing tests with `mockChatRuntime` or the pure UI helpers. |
| [`extending.md`](./extending.md) | When the built-ins don't cover the use case (custom prompt, custom context source, custom guard). |

Worker code that runs chat turns without HTTP or evaluation tooling can import from `@plumbus/chat/session` (0.3.1+, requires core 0.8.3+): `defineChat`, `runChatTurn`, the chat entities and events.

These files are **prescriptive** (do this, don't do that). For the **conceptual** reference (what it is, why it exists, design tradeoffs), see `/docs/chat/` in the Plumbus monorepo, which is also linked from each instruction file.
