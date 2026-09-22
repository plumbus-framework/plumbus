# Corpus argument landed in `@plumbus/core`

> **Locked.** Core change merged before Phase 3 implementation started.

## The problem

The chat package's `knowledgeContext` adapter is supposed to thread a `corpus` identifier through to `ctx.ai.retrieve` so consumers with multiple ingested document sets can select which one to query per chat.

At the start of chat implementation, `@plumbus/core`'s `ctx.ai.retrieve` signature was:

```ts
retrieve({ query: string; signal?: AbortSignal }): Promise<AIDocument[]>
```

There was no way to specify which corpus to query. Apps could register at most one named RAG collection, and every retrieval call hit it. This limited multi-corpus apps to writing custom retrievers that bypassed core's RAG plumbing — defeating the point of having `ctx.ai.retrieve` at all.

The implementation plan called for a verification gate (Phase 0 / Task 0.2) to decide between:

- **(a)** Landing a core change before Phase 3 starts.
- **(b)** Shipping single-corpus support (making `corpus` optional with a default).

## How it works

**Outcome: FAIL → (a) Landed core change.**

`@plumbus/core` was updated to accept `corpus`, `filter`, `limit`, and `minScore` on the retrieve config:

```ts
retrieve({
  query: string;
  corpus?: string;            // pre-registered collection name
  filter?: Record<string, unknown>;
  limit?: number;
  minScore?: number;
  signal?: AbortSignal;
}): Promise<AIDocument[]>
```

When `corpus` is omitted, behavior is unchanged (queries the app's default RAG collection). When provided, the retriever scopes to that collection and post-filters chunks by `filter` metadata.

`knowledgeContext` now requires `corpus`:

```ts
knowledgeContext({
  corpus: 'product-docs',    // REQUIRED — must match an ingested collection
  query: (t) => t.userMessage,
  filter: (t) => ({ audience: t.audience, locale: t.locale }),
})
```

Corpus ingestion remains the consumer's responsibility (via `plumbus rag ingest` or equivalent). The chat package does not own ingestion.

## Tradeoffs

**What works well:**
- Multi-corpus apps work without per-app retriever forks.
- Metadata filters (audience, locale, document category) compose with the chat's `filter` callback.
- The chat package can mandate `corpus` as required, which catches "forgot to specify which collection" at `defineChat` time rather than at first turn.

**What you give up:**
- Apps on `@plumbus/core` < 0.4.0 cannot use `@plumbus/chat`. The peer dep range (`^0.4.0 <0.5.0`) makes this explicit.
- The `corpus` arg is a string. Typos surface at first retrieval call as zero results, not at compile time. Could be tightened with a per-app registered enum if pain appears.

## Why this is a separate doc


---

## Addendum (2026-07-08)

**API rename:** Direct corpus RAG in chat is `ragContext({ corpus, query, filter?, … })`. Registry-backed KB uses `knowledgeContext({ registry, source, … })`. The old `knowledgeContext({ corpus, query })` shape is the deprecated alias `knowledgeContextLegacy`.

**Peer range:** `@plumbus/chat` declares `@plumbus/core` `"0.5.x || 0.6.x"` (copy from `packages/chat/package.json`). From chat **0.1.11**, ship core **≥ 0.6.11** — see `packages/plumbus-core/instructions/peer-dependencies.md` runtime floors.
