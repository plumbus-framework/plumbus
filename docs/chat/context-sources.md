# Corpus binding

`knowledgeContext` is the chat package's adapter over `@plumbus/core`'s RAG primitive. It does NOT own ingestion, embedding, or storage — those are core's responsibility. It only resolves a query against a named corpus at turn time.

## Shape

```ts
import { knowledgeContext } from '@plumbus/chat';

knowledgeContext({
  id?: string,                                      // stable handle (default: hash of opts)
  corpus: string,                                   // pre-registered RAG collection name
  query: string | ((turnCtx) => string),            // what to retrieve
  topK?: number,                                    // result count cap
  filter?: (turnCtx) => Record<string, unknown>,    // metadata filter
  sourceId?: string,                                // human-readable label
})
```

At each turn the resolver calls:

```ts
ctx.ai.retrieve({
  corpus: opts.corpus,
  query: typeof opts.query === 'function' ? opts.query(turnCtx) : opts.query,
  filter: opts.filter?.(turnCtx),
  // topK, limit, etc. threaded as appropriate
});
```

## Corpus registration is a core / consumer concern

The chat package never sees raw documents. Consumers run `plumbus rag ingest` (or whatever mechanism their app uses) to:

1. Chunk source documents.
2. Generate embeddings.
3. Tag chunk metadata (audience, locale, category, …).
4. Register the collection under a name (the `corpus` arg).

Once registered, multiple chats can reference the same corpus, and the same corpus can serve non-chat consumers (a search UI, agent grounding, etc.). The chat is just one client.

## Example: per-app docs corpus

```ts
// In your app's bootstrap, register a corpus from /docs:
//   plumbus rag ingest --corpus product-docs --source ./docs

// Then in a chat config:
import { knowledgeContext } from '@plumbus/chat';

const helpChat = defineChat({
  // ...
  context: [
    knowledgeContext({
      corpus: 'product-docs',
      query: (turnCtx) => turnCtx.userMessage,
      topK: 6,
      filter: (turnCtx) => ({
        audience: turnCtx.audience,            // 'user' vs 'admin' docs
        locale: turnCtx.locale,                // language-specific chunks
      }),
    }),
  ],
});
```

## Default audience filter (footgun mitigation)

If your chat declares `policy.audience` and your `knowledgeContext` does NOT provide a `filter`, the resolver attaches `({ audience }) => ({ audience })` automatically and logs a warning the first time it fires. This prevents admin-only docs leaking to a user just because you forgot to wire the filter.

Override by providing your own `filter` (even one that returns `{}` to explicitly opt out of the default).

## Source handles and provenance

The resolver issues stable runtime handles (`src_a`, `src_b`, …) to each context source. The chat's system prompt instructs the model to cite by handle (`[src:src_a]`). The provenance guard validates citations against the issued handles — the model cannot invent a handle that wasn't issued.

`AIDocument.source` from core's retrieve becomes the `label` and `metadata` on the issued `ChatSourceRef`. UI renders this via `<SourceCitation>` from `@plumbus/chat-ui`.

## When `knowledgeContext` is the wrong tool

| Situation | Use this instead |
|---|---|
| Tiny static lookup tables (path maps, surface lists) | `staticContext` — no retrieval, no token cost beyond the inline items |
| i18n catalogs as context | `staticContextFromTranslations` — built from `ctx.translations`, never drifts |
| Live per-user data (account state, billing) | `capabilityContext(getOwnState)` — refreshed per turn from the source of truth |
| Curated wiki of summarized entity pages | Custom `ContextSource` over the wiki, or a future `@plumbus/wiki` package — `knowledgeContext` is raw RAG, not summarized |

## Corpus prerequisite (Decision 0010)

`ctx.ai.retrieve({ corpus, query, filter? })` requires `@plumbus/core` 0.4.0+. The `corpus` arg was added to core specifically for this package. If you're on an older core, either upgrade or write a custom `ContextSource` that calls your retriever directly.
