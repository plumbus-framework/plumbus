# Chat integration

Requires optional peer `@plumbus/knowledge-base@^0.1.0`.

## Registry-backed context source

```ts
import { defineChat, knowledgeContext } from '@plumbus/chat';
import { knowledgeRegistry } from '../knowledge/index.js';

export const helpChat = defineChat({
  context: [
    knowledgeContext({
      registry: knowledgeRegistry,
      source: 'help-kb',
      id: 'help-knowledge',       // optional stable id
      sourceId: 'help-kb',        // optional provenance on ContextItem
    }),
  ],
});
```

At resolve time chat:

1. Builds `KnowledgeScope` from turn (see below).
2. Calls `registry.get(source).getBlock(ctx, scope, { maxTokens: turnCtx.contextTokenBudget, query })`.
3. Emits one `ContextItem` (`kind: 'text'`) into the system prompt pipeline.

## `scopeFromTurn` — default and override

**Default** (when `scopeFromTurn` omitted):

```ts
(turnCtx) => ({
  audience: turnCtx.audience,
  locale: turnCtx.locale,
  tenantId: turnCtx.tenantId,
});
```

**Override** when chat policy fields are not enough:

```ts
knowledgeContext({
  registry,
  source: 'project-docs',
  scopeFromTurn: (turnCtx) => ({
    audience: turnCtx.audience,
    locale: turnCtx.locale,
    tenantId: turnCtx.tenantId,
    custom: { userId: turnCtx.userId },
  }),
}),
```

`TurnContext` today includes `sessionId`, `ordinal`, `userId`, `audience`, `locale`, `tenantId`, `userMessage`, `contextTokenBudget`, etc. Map any of these turn fields into `custom` for `documentCollection` frontmatter or `ragCorpus` filters.

## `queryFromTurn` — when required

| Source type | Need `queryFromTurn`? |
|-------------|----------------------|
| `staticBlocks`, `translationCatalog`, `documentCollection`, `capabilityBacked` | No — content does not depend on user message |
| `ragCorpus` with `queryStrategy: 'fromOpts'` (default) | **Yes** — otherwise retrieve gets no query |

```ts
knowledgeContext({
  registry,
  source: 'help-rag',
  queryFromTurn: (t) => t.userMessage ?? '',
}),
```

`userMessage` is the post-`beforeTurn` user text, stamped on `TurnContext` before context resolution.

**Decision tree:**

```
  Is the source ragCorpus (or custom) using fromOpts / opts.query?
        |
       yes --> queryFromTurn: (t) => t.userMessage ?? ''
        |
        no  --> omit queryFromTurn
```

Alternative: configure `ragCorpus({ queryStrategy: 'scopeAsQuery' })` to derive query from scope fields (niche; most apps use `fromOpts` + `queryFromTurn`).

## Tier 2 in chat

```ts
knowledgeContext({ registry, source: 'help-rag', tier: 'tools' });
// throws at construction:
// knowledge.chat_tier_not_supported: tier 'tools' is interface-only ...
```

Use `tier: 'block'` (default). Tier 2 remains for custom agent hosts — see [usage-patterns.md](./usage-patterns.md#4-agent-grounding-tools-tier-2--custom-host).

## Token budget

- Each context source receives **`turnCtx.contextTokenBudget`** as `maxTokens` for its `getBlock` call.
- Multiple `knowledgeContext` entries each get the full budget independently during resolution.
- **`trimContextToBudget`** in chat is the global cap across all sources.

Practical rule: keep static policy blocks small when combining with RAG on the same turn.

## Direct RAG without registry (`ragContext`)

When you do not install KB:

```ts
import { ragContext } from '@plumbus/chat';

defineChat({
  context: [
    ragContext({
      corpus: 'help-docs-v1',
      query: (t) => t.userMessage ?? '',
      filter: (t) => ({ audience: t.audience }),
    }),
  ],
});
```

## Audience filter warning (ragContext only)

When the chat declares `policy.audience`, `runChatTurn` enables default audience filtering on `ragContext` sources that omit an explicit `filter`: retrieve receives `{ audience: turnCtx.audience }` and logs a one-time warning. Opt out with `parentChatAudiencePolicy: false` on that source.

Registry-backed `knowledgeContext` does not auto-attach retrieve filters — audience flows through `scopeFromTurn` (default maps `audience`, `locale`, `tenantId`) into KB scope / `ragCorpus` `mapScope` instead.
