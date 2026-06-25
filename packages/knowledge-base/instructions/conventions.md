# @plumbus/knowledge-base — Conventions for AI Agents

> **Concepts** (three tiers, scope, rankers, registry freezing, result types): read `docs/knowledge-base/README.md` in the Plumbus monorepo — not this file.

Use this package when the app needs **named, scoped knowledge sources** shared across chat, capabilities, tooltips, or search UIs — not for one-off `ctx.ai.retrieve` in a single script (use `@plumbus/chat` `ragContext` or core retrieve directly).

**`package.json` peer (framework releases):** `"@plumbus/core": "0.5.x || 0.6.x"` — copy from `packages/mcp/package.json`; see `packages/plumbus-core/instructions/peer-dependencies.md`.

**Do NOT** add vector ingest, chunking, or `plumbus knowledge ingest` — RAG ingest is **only** `plumbus rag ingest` in `@plumbus/core`. KB's `ragCorpus` calls `ctx.ai.retrieve` only.

**Do NOT** import `VectorStore`, `chunkDocument`, or `createRAGPipeline` inside consumer KB wiring — forbidden in the KB package itself.

## Entry points

| You want to… | Reach for |
|---|---|
| Declare a source | `defineKnowledgeSource({ name, provider })` |
| Compose sources | `createKnowledgeRegistry({ sources })` at app boot |
| Chat grounding (registry) | `knowledgeContext({ registry, source })` from `@plumbus/chat` |
| Chat grounding (direct RAG) | `ragContext({ corpus, query })` — no KB package |
| Tier-1 text in a capability | `registry.get('x').getBlock(ctx, scope, { maxTokens })` |
| Tier-3 search UI | `registry.get('x').search(ctx, query, scope, { topK })` |
| Tests | `@plumbus/knowledge-base/testing` |

## Package conventions

| Element | Convention | Example |
|---|---|---|
| Source `name` | lowercase kebab-case | `help-kb`, `product-rag` |
| Registry module | one `createKnowledgeRegistry` export | `app/knowledge/index.ts` |
| Chat wiring | pass frozen registry into `knowledgeContext` | not `ctx.knowledge` global |

## File map (`src/`)

| Concern | Path |
|---|---|
| Public barrel | `src/index.ts` |
| `defineKnowledgeSource` | `src/define/defineKnowledgeSource.ts` |
| Registry | `src/registry/create-knowledge-registry.ts` |
| Providers | `src/providers/*.ts` |
| Scope → RAG filter | `src/scope/to-retrieve-filter.ts` |
| Rank / pack | `src/ranker/scope-specificity.ts`, `pack-blocks.ts` |
| Test helpers | `src/testing/index.ts` |

## Critical rules

1. **Registry is frozen at boot** — no runtime `registry.add()`. Rebuild registry to change sources.
2. **`ragCorpus` + chat** — always set `queryFromTurn` when `queryStrategy` is `'fromOpts'` (default).
3. **`knowledgeContext({ tier: 'tools' })`** — throws at construction; use tier 1 only.
4. **`capabilityBacked`** — stricter than chat `capabilityContext` (no `external` effects, `ai` must be false).
5. **Duplicate source names** — `createKnowledgeRegistry` throws; fix at boot, not in handlers.
6. **Two chat helpers** — `knowledgeContext({ registry, source })` (registry); `ragContext({ corpus, query })` (direct retrieve, no KB package).

## Cross-package

| Package | Role |
|---|---|
| `@plumbus/core` | `ctx.ai.retrieve`, translations, capabilities |
| `@plumbus/chat` | `knowledgeContext`, `ragContext`, `resolveContextSources` |

## Instruction index

- [defining-sources.md](./defining-sources.md) — add a source recipe
- [providers.md](./providers.md) — provider picker
- [chat-integration.md](./chat-integration.md) — chat wiring recipe
- [testing.md](./testing.md) — test patterns
