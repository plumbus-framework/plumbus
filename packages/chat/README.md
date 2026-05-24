# @plumbus/chat

Policy-first conversation runtime for Plumbus applications. Declares chats with `defineChat()`, runs turns via `runChatTurn()`, and composes on `@plumbus/core` for RAG, capabilities, prompts, and persistence.

## Install

Peer dependency: `@plumbus/core` `^0.4.0 <0.5.0`.

## Quick start

```ts
import { defineChat, knowledgeContext, runChatTurn } from '@plumbus/chat';

export const helpChat = defineChat({
  name: 'help',
  access: { roles: ['user'] },
  context: [knowledgeContext({ corpus: 'docs', query: 'help' })],
  policy: { scope: { description: 'Product help only' } },
  exposeAs: 'sse',
});
```

## Docs

Full documentation lives in the monorepo's [`docs/chat/`](../../docs/chat/) folder:

- [`README.md`](../../docs/chat/README.md) — overview, when to use, package layout
- [`defining-chats.md`](../../docs/chat/defining-chats.md) — authoring `defineChat` configs
- [`policies.md`](../../docs/chat/policies.md) — the seven built-in guards
- [`context-sources.md`](../../docs/chat/context-sources.md) — `knowledgeContext` / `capabilityContext` / `staticContext`
- [`testing.md`](../../docs/chat/testing.md) — `mockChatRuntime` + helpers
- [`evaluations.md`](../../docs/chat/evaluations.md) — v0.2 preview
- [`design/`](../../docs/chat/design/) — 10 design decisions explaining the framework's shape

## React UI

Use [`@plumbus/chat-ui`](../chat-ui/) for `ChatPanel`, `useChat`, and SSE client helpers.

## Testing

```bash
pnpm test
```

Use `mockChatRuntime` from `@plumbus/chat/testing` with `createTestContext` and `mockAI`.
