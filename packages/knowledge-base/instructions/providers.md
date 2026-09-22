# Knowledge Providers — Agent Picker

Full examples and decision guide: `docs/knowledge-base/providers.md` in the Plumbus monorepo.

## Quick picker

```
  Content lives where?
        |
        +-- In code / config ---------> staticBlocks
        +-- In app/translations -------> translationCatalog (+ definitions OR getCatalog)
        +-- From read-only capability --> capabilityBacked
        +-- Markdown on disk ----------> documentCollection
        +-- RAG corpus (ingested) -----> ragCorpus (+ plumbus rag ingest)
```

| Provider | Chat `queryFromTurn`? | Tiers |
|----------|------------------------|-------|
| `staticBlocks` | No | 1 |
| `translationCatalog` | No | 1 |
| `capabilityBacked` | No | 1 |
| `documentCollection` | No | 1 |
| `ragCorpus` | **Yes** (default `fromOpts`) | 1, 2, 3 |

## Rules

- **Never** add ingest CLI or vector imports in app code for KB — `plumbus rag ingest` only.
- **`translationCatalog`** — use `definitions` for normal translation files; `getCatalog` only when catalog is dynamic (DB/CMS).
- **`capabilityBacked`** — capability must have no `data`/`events`/`external` effects and `ai: false`.
- **`documentCollection`** — built-in YAML parser only reads `audience`, `locale`, `tenantId`; use `frontmatterParser` for `custom` keys.
- **`ragCorpus`** — corpus name must match ingest; use `mapScope` if retrieve metadata shape differs from default flatten. End-to-end ingest → retrieve → chat wiring: `docs/knowledge-base/rag-via-core.md` in the Plumbus monorepo.

## Do / Don't

| Do | Don't |
|---|---|
| One provider per `defineKnowledgeSource` | Combine unrelated backends in one custom provider without reason |
| Version corpus names (`help-docs-v1`) | Reuse corpus name across incompatible embedding policies |
| `minScore` / `topK` on `ragCorpus` for quality | Call tier 3 `search` from chat context helpers |
