# @plumbus/knowledge-base

Optional Plumbus package for **audience-scoped, queryable knowledge** — one provider interface, many content backends, composed through an explicit registry at app boot.

Use it when several features (chat, tooltips, agents, admin search) need the same facts under the same scope rules, without each feature calling `ctx.ai.retrieve` or duplicating i18n strings.

## Quickstart

```ts
import {
  createKnowledgeRegistry,
  defineKnowledgeSource,
  staticBlocks,
} from '@plumbus/knowledge-base';

export const helpKb = defineKnowledgeSource({
  name: 'help-kb',
  description: 'In-product help facts',
  provider: staticBlocks({
    blocks: [
      { text: 'Interview pages support AI-assisted Q&A.', scope: { audience: 'user' } },
      { text: 'Admin ops runbooks live here.', scope: { audience: 'admin' } },
    ],
  }),
});

export const knowledgeRegistry = createKnowledgeRegistry({ sources: [helpKb] });

const block = await knowledgeRegistry
  .get('help-kb')
  .getBlock(ctx, { audience: 'user', locale: 'en' }, { maxTokens: 500 });
```

Wire into chat (`@plumbus/chat@0.1.4`):

```ts
import { knowledgeContext } from '@plumbus/chat';

defineChat({
  context: [knowledgeContext({ registry: knowledgeRegistry, source: 'help-kb' })],
});
```

## Docs

Full documentation lives in the monorepo's [`docs/knowledge-base/`](../../docs/knowledge-base/) folder:

- [`README.md`](../../docs/knowledge-base/README.md) — overview, registry, scope, tiers, result types
- [`defining-sources.md`](../../docs/knowledge-base/defining-sources.md) — `defineKnowledgeSource`, rankers, `packBlocks`
- [`providers.md`](../../docs/knowledge-base/providers.md) — all five built-in providers
- [`usage-patterns.md`](../../docs/knowledge-base/usage-patterns.md) — chat, capability, search UI, agents
- [`chat-integration.md`](../../docs/knowledge-base/chat-integration.md) — `knowledgeContext`, `ragContext`
- [`rag-via-core.md`](../../docs/knowledge-base/rag-via-core.md) — ingest → retrieve
- [`testing.md`](../../docs/knowledge-base/testing.md) — test helpers

## Agent instructions

Prescriptive recipes ship in [`instructions/`](./instructions/) (included in the npm tarball):

- [`instructions/conventions.md`](./instructions/conventions.md) — conventions and critical rules
- [`instructions/defining-sources.md`](./instructions/defining-sources.md) — add a source
- [`instructions/providers.md`](./instructions/providers.md) — provider picker
- [`instructions/chat-integration.md`](./instructions/chat-integration.md) — wire chat
- [`instructions/testing.md`](./instructions/testing.md) — test patterns

## Version matrix

| Package | Version | Relationship |
|---------|--------:|--------------|
| `@plumbus/knowledge-base` | `0.1.0` | New optional package |
| `@plumbus/chat` | `0.1.4` | Registry-backed `knowledgeContext`; KB is optional peer |
| `@plumbus/core` | `^0.4.0 <0.5.0` | Required peer (`ctx`, RAG, capabilities, translations) |

## Deferred (v0.2+)

Auto-discovery, file watching, governance, chat tier-2 tool execution, `databaseCollection`, hybrid retrieval.
