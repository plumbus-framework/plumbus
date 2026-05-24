# Context Sources — Agent Recipe

A chat's `context: [...]` array tells the runtime what data to inject into the model prompt each turn. Sources resolve **eagerly and in parallel** before the model call — no agentic mid-generation tool calls in v0.1.

## Picker: which built-in to use

| Data shape | Use this |
|---|---|
| Tiny static lookup (path map, surface list, status enum) | `staticContext` |
| Same data, already in `app/translations/` catalogs | `staticContextFromTranslations` |
| Long-tail docs, FAQs, knowledge base | `knowledgeContext` over a registered RAG corpus |
| Live per-user data (account state, billing snapshot) | `capabilityContext(getOwnState)` |
| Curated wiki of summarized entity pages | Custom `ContextSource` |

If the data fits in <2KB and never changes, use `staticContext`. If it's bigger and updates over time, use `knowledgeContext`. If it's per-user and live, use `capabilityContext`.

## Recipes

### `staticContext` — inline structured items

```ts
import { staticContext } from '@plumbus/chat';

const pathMap = staticContext({
  id: 'paths',
  sourceId: 'product-paths',
  items: [
    { id: '/project', kind: 'text', content: 'Project page — set up book metadata.' },
    { id: '/interview', kind: 'text', content: 'Interview page — talk with the AI.' },
    { id: '/timeline', kind: 'text', content: 'Timeline page — review extracted events.' },
  ],
});

defineChat({ context: [pathMap, /* ... */] });
```

### `staticContextFromTranslations` — from i18n catalogs

```ts
import { staticContextFromTranslations } from '@plumbus/chat';

const navSurfaces = staticContextFromTranslations({
  id: 'nav-surfaces',
  namespaces: ['nav', 'admin.nav'],
  sourceId: 'product-nav',
});
```

Catalog renames flow automatically — no drift between chat and `app/translations/`.

### `capabilityContext` — live per-user data

```ts
import { capabilityContext } from '@plumbus/chat';
import { getOwnBillingStatus } from '../capabilities/get-own-billing-status.js';

const billingStatus = capabilityContext(getOwnBillingStatus, {
  buildInput: (turnCtx) => ({ userId: turnCtx.userId }),
});
```

**The capability MUST be read-only.** `capabilityContext` rejects capabilities with any `effects.data` or `effects.events` at construction time. For writes, use `actions:` + `policy.action.allowedCapabilities`.

### `knowledgeContext` — RAG over a registered corpus

```ts
import { knowledgeContext } from '@plumbus/chat';

const docs = knowledgeContext({
  corpus: 'product-docs',                    // REQUIRED — must match an ingested collection
  query: (turnCtx) => turnCtx.userMessage,
  topK: 6,
  filter: (turnCtx) => ({
    audience: turnCtx.audience,
    locale: turnCtx.locale,
  }),
});
```

The corpus is pre-registered via `plumbus rag ingest` (or whatever ingestion the consumer app uses). The chat package does not own ingestion.

## Source Handles and Citations

The resolver issues stable handles in source-declaration order: `src_a`, `src_b`, `src_c`, ... The chat's system prompt instructs the model to cite by handle (`[src:src_a]`). The provenance guard validates citations and strips invalid IDs.

When testing, use the resolver's handle scheme — don't invent IDs:

```ts
ai: mockAI({
  generate: {
    inScope: true,
    answer: 'Open the [src:src_a] page.',     // first declared source gets src_a
    citedSources: ['src_a'],
    refusalReason: null,
    requestedAction: null,
  },
}),
```

Only the **cited** subset is persisted on `ChatTurnRow.sources`. The full retrieved set is debugging data; the cited set is the audit trail.

## Do's

- **Do** declare sources in stable order — handle assignment depends on it. Changing order breaks existing citation history.
- **Do** provide a `filter` callback on `knowledgeContext` when the corpus has multi-audience or multi-locale chunks. (If you forget AND `policy.audience` is set, the resolver auto-attaches `({ audience }) => ({ audience })` and warns once.)
- **Do** use `staticContextFromTranslations` for any data that lives in `app/translations/`. Hand-copying creates drift.
- **Do** wrap small lookup tables in `staticContext` instead of stuffing them into `instructions: [...]` — you get provenance + budget accounting.
- **Do** set `topK` reasonably on `knowledgeContext`. Default behavior depends on core's RAG config; explicit is better.

## Don'ts

- **Don't** use a write-effect capability as `capabilityContext` — construction-time error. Use `policy.action` for writes.
- **Don't** invent source IDs in tests, fixtures, or model output. The resolver issues them deterministically.
- **Don't** put 50 KB of static data in `staticContext`. The context-budget trimmer will drop other (knowledge) sources first to make room.
- **Don't** assume context sources can mutate state. They're read-only by contract.
- **Don't** rely on `ctx.ai.retrieve` defaulting to a single corpus — `knowledgeContext` requires `corpus` to be specified.

## Custom Context Source

If none of the built-ins fit, write your own. `ContextSource` is an open interface:

```ts
import type { ContextSource, TurnContext, ResolvedContext } from '@plumbus/chat';
import type { ExecutionContext } from '@plumbus/core';

export function wikiContext(opts: { wikiPath: string }): ContextSource {
  return {
    kind: 'knowledge',                       // pick the closest of the three
    id: `wiki:${opts.wikiPath}`,             // stable ID — never Math.random
    async resolve(ctx: ExecutionContext, turnCtx: TurnContext): Promise<ResolvedContext> {
      // ... your retrieval logic ...
      return {
        items: [/* ContextItem[] */],
        sources: [/* ChatSourceRef[] */],
        estimatedTokens: 0,
      };
    },
  };
}
```

Use it like any built-in: `context: [wikiContext({ wikiPath: '/wiki' })]`.

## Deeper Reference

- `/docs/chat/context-sources.md` — full conceptual reference
- `/docs/chat/design/static-context-helpers.md` — why static + translation helpers exist
- `/docs/chat/design/corpus-arg-in-core.md` — the corpus arg landing in core
- `src/context/resolver.ts` — handle assignment logic
- `src/context/knowledge-context.ts` — corpus binding implementation
