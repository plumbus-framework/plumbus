# Knowledge base (`@plumbus/knowledge-base`)

Optional Plumbus package for **audience-scoped, queryable knowledge** — one `KnowledgeProvider` contract, multiple factory functions (`staticBlocks`, `ragCorpus`, …), and a **frozen registry** you build once at boot and pass into chat, capabilities, or agents.

The runtime lives in [`packages/knowledge-base`](../../packages/knowledge-base). It is **not** a global `ctx.knowledge` singleton and **not** a second vector database. RAG storage and ingest remain in `@plumbus/core`; KB only adapts them.

These docs are split in two:

- **Usage** (the files in this folder) — concepts, providers, scope, chat wiring, testing. Human-readable, explanatory.
- **Agent instructions** — prescriptive "do this / don't do that" recipes for AI coding agents. Lives at [`packages/knowledge-base/instructions/`](../../packages/knowledge-base/instructions/) and ships in the npm tarball. The instructions cross-link back here for conceptual depth.

## Usage docs

| Doc | Read when… |
|---|---|
| [defining-sources.md](./defining-sources.md) | Authoring `defineKnowledgeSource`, custom providers, rankers, `packBlocks` |
| [providers.md](./providers.md) | Choosing and configuring the five built-in providers |
| [usage-patterns.md](./usage-patterns.md) | Chat, capability, search UI, agent tools, multi-source shapes |
| [chat-integration.md](./chat-integration.md) | `knowledgeContext`, `scopeFromTurn`, `queryFromTurn`, `ragContext` |
| [rag-via-core.md](./rag-via-core.md) | Ingest → retrieve pipeline, corpus naming, `mapScope` |
| [testing.md](./testing.md) | `mockKnowledgeSource`, `createTestRegistry`, `expectKnowledgeCalled` |
| [../chat/context-sources.md](../chat/context-sources.md) | Chat context helpers including direct `ragContext` |

## Agent instructions

Read these when you're an AI agent extending a Plumbus app that uses knowledge-base. They ship in `node_modules/@plumbus/knowledge-base/instructions/`:

- [`instructions/conventions.md`](../../packages/knowledge-base/instructions/conventions.md) — file map, conventions, critical rules
- [`instructions/defining-sources.md`](../../packages/knowledge-base/instructions/defining-sources.md) — recipe for adding a source
- [`instructions/providers.md`](../../packages/knowledge-base/instructions/providers.md) — provider picker
- [`instructions/chat-integration.md`](../../packages/knowledge-base/instructions/chat-integration.md) — wiring `knowledgeContext`
- [`instructions/testing.md`](../../packages/knowledge-base/instructions/testing.md) — test patterns

## Architecture

```
  app boot
     |
     v
 defineKnowledgeSource x N  -->  createKnowledgeRegistry
     |                                    |
     |                                    +--> registry.get('help-kb').getBlock(ctx, scope)
     |                                    +--> registry.get('docs').search(ctx, query, scope)
     v
 @plumbus/chat knowledgeContext({ registry, source })
```

## Why a registry (not `ctx.knowledge`)

1. **Explicit composition** — Every source appears in one array at boot. No hidden auto-discovery.
2. **Testability** — Swap `createTestRegistry([mock])` without patching globals.
3. **Optional install** — Apps without KB never pay for it; chat works with `ragContext` alone.
4. **Multiple consumers, one truth** — Chat, admin UI, and tooltips call the same source with the same scope rules.

## Registry freezing and composition

`createKnowledgeRegistry({ sources })` **deep-freezes** the source definition list and the returned registry object. After construction:

- You **cannot** add, remove, or replace sources at runtime.
- `registry.list()` returns the same frozen definitions; mutating them throws in strict mode or silently fails elsewhere.
- `registry.get(name)` returns a stable runtime wrapper around the provider frozen at boot.

There is **no** parent/child registry, merge API, or dynamic registration. To change sources, build a **new** registry (typically at app boot) and pass that instance to consumers. For tests, use `createTestRegistry` from `@plumbus/knowledge-base/testing` — same freeze semantics as production.

`defineKnowledgeSource` also deep-freezes each definition when created.

## Scope

Knowledge is rarely universal. Admin help ≠ user help. Hebrew ≠ English. Tenant A ≠ Tenant B.

`KnowledgeScope` fields:

| Field | Typical source | Purpose |
|-------|----------------|---------|
| `audience` | Chat policy, route | `user` vs `admin` content split |
| `locale` | `ctx.translations.locale`, user pref | i18n-aligned blocks |
| `tenantId` | Auth context | SaaS isolation |
| `custom` | Feature-specific | e.g. `{ projectId: '…' }` for scoped docs |

**Filtering (tier-1 static providers):** A block with `scope: { audience: 'admin' }` does not match `{ audience: 'user' }`. Any **unset** dimension on the block is a wildcard (matches any request value for that dimension). For `custom`, every key present on the block must match the request's `custom` values; extra keys on the request are ignored.

**Ranking:** When several blocks match, `scopeSpecificityRanker` prefers blocks that match more scope dimensions. Source-level `ranker` on `defineKnowledgeSource` is invoked by `createKnowledgeRegistry` unless the provider supplies a per-call override. Details: [defining-sources.md → Rankers and packing](./defining-sources.md#rankers-and-packing).

**RAG filters:** `scopeToRetrieveFilter(scope)` builds the retrieve filter as `{ audience?, locale?, tenantId?, ...custom }` — top-level scope fields plus a shallow spread of `custom`. Override with `ragCorpus({ mapScope })`. Ingest metadata keys must align with what you pass at query time.

**Document frontmatter:** The built-in parser reads `audience`, `locale`, and `tenantId` from YAML into `KnowledgeScope`. Feature-specific keys need a custom `frontmatterParser` (e.g. map `projectId` → `scope.custom.projectId`). Matching uses the same rules as static blocks once scope is parsed.

## Why the RAG adapter is thin

`ragCorpus` does not import vector stores, chunkers, or ingest pipelines from core. KB only calls `ctx.ai.retrieve`. Ingest stays on `plumbus rag ingest`. See [rag-via-core.md](./rag-via-core.md).

## Three tiers

```
  Tier 1 getBlock     "What text goes in the prompt?"
  Tier 2 getTools     "What tools should an LLM see?" (chat does not execute these)
  Tier 3 search       "I will render hits myself"
```

| Tier | Method | Typical use |
|------|--------|-------------|
| 1 | `getBlock` | Chat system prompt, tooltips |
| 2 | `getTools` | Custom agent hosts |
| 3 | `search` | Admin search UI, debug consoles |

Unsupported tiers throw `knowledge.tier_not_supported` (provider) or `knowledge.chat_tier_not_supported` (chat `knowledgeContext({ tier: 'tools' })` at construction).

## Result types: `ScoredBlock` vs `SearchResult`

Both are exported; they serve different tiers:

| Type | Used in | Shape | Role |
|------|---------|-------|------|
| `ScoredBlock` | Tier 1 pipeline inside providers | `{ text, score, scope? }` | One injectable fragment before packing |
| `SearchResult` | Tier 3 `search()` return | `{ content, score, metadata? }` | One retrieval hit for UIs or custom ranking |

**Flow:** Tier 3 `ragCorpus.search` maps `ctx.ai.retrieve` documents → `SearchResult[]`. Tier 1 `ragCorpus.getBlock` runs the same retrieve, maps hits to `ScoredBlock[]` (`text` ← `content`, vector `score`, optional `scope` from the request), then `packBlocks` joins them into one string. Static providers build `ScoredBlock[]` directly from blocks or translations, rank with `scopeSpecificityRanker`, then pack.

`packBlocks` and `estimateTokens` are public for custom providers that want the same token-budget behavior. Algorithm: [defining-sources.md → Rankers and packing](./defining-sources.md#rankers-and-packing).

## When to use KB

- Grounding **chat** with registry-backed sources (`knowledgeContext`).
- **Tooltips / autofill** sharing scoped facts with chat.
- **Read-only capabilities** as narrative blocks (`capabilityBacked`).
- **Semantic search UIs** (`registry.get('x').search`).
- **i18n-backed help** (`translationCatalog`).

## When not to use KB

- One-off `ctx.ai.retrieve` with no reuse — use `ragContext` or retrieve directly.
- Write-heavy capabilities as knowledge — `capabilityBacked` is read-only only.
- Mandatory framework install — KB is optional; there is no `ctx.knowledge`.

## Custom providers

Implement `KnowledgeProvider` (`getBlock` required; `getTools` / `search` optional). Wrap with `defineKnowledgeSource`. See [defining-sources.md](./defining-sources.md).

## Error codes

| Code | Meaning |
|------|---------|
| `knowledge.define_invalid` | Bad `defineKnowledgeSource` config |
| `knowledge.duplicate_source` | Two sources with same `name` |
| `knowledge.source_not_found` | `registry.get('unknown')` |
| `knowledge.tier_not_supported` | Provider method not implemented |
| `knowledge.document_load_failed` | `documentCollection` IO error |
| `knowledge.translation_unavailable` | Missing namespace/locale in catalog |
| `knowledge.capability_not_readonly` | `capabilityBacked` on write/AI cap |
| `knowledge.rag_retrieve_failed` | `ctx.ai.retrieve` threw |

## Related packages

- `@plumbus/chat` — [chat-integration.md](./chat-integration.md), [context-sources](../chat/context-sources.md)
- `@plumbus/knowledge-base/testing` — [testing.md](./testing.md)

## Out of scope

Not implemented: auto-discovery, file watching, governance, observability, `databaseCollection`, hybrid retrieval, chat tier-2 execution, registry merge/composition APIs.
