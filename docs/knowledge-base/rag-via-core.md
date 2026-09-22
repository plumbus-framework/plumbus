# RAG via @plumbus/core

`ragCorpus` is a **thin adapter** over `ctx.ai.retrieve`. KB does not ship vector stores, chunkers, or ingest CLIs.

## Architecture

```
  plumbus rag ingest          app runtime
        |                           |
        v                           v
  core vector index  <----  ctx.ai.retrieve({ corpus, query, filter, limit, minScore })
                                    ^
                                    |
                              ragCorpus provider
                                    ^
                                    |
                         knowledgeContext + queryFromTurn
```

## Core symbols

| Symbol | Role |
|--------|------|
| `ctx.ai.retrieve` | Semantic search; returns `AIDocument[]` with `content`, `score`, `metadata?`, `source` |
| `executeCapability` | Used by `capabilityBacked`, not by `ragCorpus` |
| `plumbus rag ingest` | **Only** supported ingest CLI for corpora |

Verified against `@plumbus/core@0.5.x` — see [`packages/knowledge-base/instructions/preflight-v1.md`](../../packages/knowledge-base/instructions/preflight-v1.md) (internal v1 implementation QA record).

## End-to-end: ingest → chat grounding

### 1. Ingest documents (core CLI)

```bash
# Example — exact flags depend on your app's RAG config
plumbus rag ingest --corpus help-docs-v1 --path ./content/help
```

There is **no** `plumbus knowledge ingest`. Corpus name here must match `ragCorpus({ corpus: '...' })`.

### 2. Define KB source

```ts
import { defineKnowledgeSource, ragCorpus, createKnowledgeRegistry } from '@plumbus/knowledge-base';

export const helpRagKb = defineKnowledgeSource({
  name: 'help-rag',
  provider: ragCorpus({
    corpus: 'help-docs-v1',
    topK: 5,
    minScore: 0.65,
  }),
});

export const knowledgeRegistry = createKnowledgeRegistry({ sources: [helpRagKb] });
```

### 3. Wire chat

```ts
import { knowledgeContext } from '@plumbus/chat';

knowledgeContext({
  registry: knowledgeRegistry,
  source: 'help-rag',
  queryFromTurn: (t) => t.userMessage ?? '',
});
```

### 4. Ensure retrieve filters match ingest metadata

When ingesting, attach metadata you will filter on (audience, locale, tenantId). At query time:

```ts
ragCorpus({
  corpus: 'help-docs-v1',
  mapScope: (scope) => ({
    audience: scope.audience,
    locale: scope.locale,
    tenantId: scope.tenantId,
    ...scope.custom,
  }),
});
```

Default when `mapScope` omitted: `scopeToRetrieveFilter(scope)`:

```ts
// packages/knowledge-base/src/scope/to-retrieve-filter.ts
{ audience?, locale?, tenantId?, ...custom }
```

**How `custom` flattens:** `scope.custom` keys are spread into the retrieve filter at the **top level**, not nested under a `custom` property. Example:

```ts
scopeToRetrieveFilter({
  audience: 'user',
  custom: { projectId: 'project-42', docType: 'faq' },
});
// → { audience: 'user', projectId: 'project-42', docType: 'faq' }
```

Ingest must store the same metadata keys on chunks (e.g. `projectId` in document metadata). A mismatch between ingest tags and `mapScope` / `scopeFromTurn` is the most common cause of "RAG returns nothing."

## Corpus naming guidance

- Use **versioned** names (`help-docs-v1`) so re-ingest can cut over without breaking running apps.
- One corpus per distinct embedding policy (language, chunk size, model).
- Multiple KB sources may point at the same corpus with different `mapScope` / `minScore` if needed.

## `minScore` and `topK`

```ts
ragCorpus({
  corpus: 'help-docs-v1',
  topK: 8,
  minScore: 0.7, // passed to ctx.ai.retrieve
});
```

Per-call override on tier 3: `source.search(ctx, query, scope, { topK: 20 })`.

## Tier 1 behavior

`getBlock` runs retrieve, maps hits to `ScoredBlock[]`, packs with `packBlocks` under `maxTokens`. If `query` is empty and strategy is `fromOpts`, returns `''` without calling retrieve.

## Tier 2 tool shape

`getTools` returns one tool per corpus:

- `name`: `searchCorpus_<corpus>`
- `inputSchema`: `{ query: string }`
- `handler`: calls the same search function as tier 3

Chat does not execute these tools.

## Errors

Retrieve failures wrap as `knowledge.rag_retrieve_failed` with corpus name in the message.

## KB-local `ToolDefinition`

Tier 2 uses types from `@plumbus/knowledge-base`, not core MCP tool exports — keeps KB optional and versioned separately from MCP.

## Do not import in KB code

Forbidden in `@plumbus/knowledge-base` package sources:

- `VectorStore`
- `chunkDocument`
- `createRAGPipeline`

Grep CI in Plumbus enforces this via `packages/knowledge-base/src/__tests__/no-vector-store-imports.test.ts` (vitest scans all non-test `src/**/*.ts` for forbidden symbols). The test runs in the monorepo `pnpm test` graph. Consumers ingest via core only.
