# Chat Integration — Agent Recipe

Requires `@plumbus/chat@0.1.4+` and optional `@plumbus/knowledge-base@^0.1.0`. Full detail: `docs/knowledge-base/chat-integration.md` in the Plumbus monorepo.

## Registry-backed (preferred when multiple sources or reuse)

```ts
import { defineChat, knowledgeContext } from '@plumbus/chat';
import { knowledgeRegistry } from '../knowledge/index.js';

export const helpChat = defineChat({
  context: [
    knowledgeContext({
      registry: knowledgeRegistry,
      source: 'help-kb',
      // scopeFromTurn: optional — default maps audience, locale, tenantId
      // queryFromTurn: required for ragCorpus (fromOpts)
    }),
  ],
});
```

## RAG source checklist

```ts
knowledgeContext({
  registry,
  source: 'help-rag',
  queryFromTurn: (t) => t.userMessage ?? '',
  scopeFromTurn: (t) => ({
    audience: t.audience,
    locale: t.locale,
    tenantId: t.tenantId,
    custom: { userId: t.userId },
  }),
});
```

## Direct RAG (no KB package)

```ts
import { ragContext } from '@plumbus/chat';

ragContext({
  corpus: 'help-docs-v1',
  query: (t) => t.userMessage ?? '',
  filter: (t) => ({ audience: t.audience }),
});
```

## Do / Don't

| Do | Don't |
|---|---|
| `tier: 'block'` (default) | `tier: 'tools'` — throws at construction |
| Keep static policy blocks small when pairing with RAG | Assume per-source `maxTokens` stacks — chat trims globally after |
| Map session metadata into `scope.custom` for scoped docs | Forget `queryFromTurn` on `ragCorpus` |

Consumer chat docs: `docs/chat/context-sources.md` in the Plumbus monorepo.
