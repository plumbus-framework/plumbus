# Knowledge providers

Built-in factories return a `KnowledgeProvider`. Compose with `defineKnowledgeSource`, then `createKnowledgeRegistry`.

## Decision guide

```
  Content lives where?
        |
        +-- In code / config ---------> staticBlocks
        +-- In app/translations -------> translationCatalog
        +-- From read-only capability --> capabilityBacked
        +-- Markdown files on disk ----> documentCollection
        +-- Embedded RAG corpus -------> ragCorpus (+ plumbus rag ingest)
```

| Provider | Tier 1 | Tier 2 | Tier 3 | Ranker override |
|----------|:------:|:------:|:------:|:---------------:|
| `staticBlocks` | yes | no | no | yes |
| `translationCatalog` | yes | no | no | n/a |
| `capabilityBacked` | yes | no | no | n/a |
| `documentCollection` | yes | no | no | yes |
| `ragCorpus` | yes | yes | yes | no (vector scores) |

Unsupported tiers throw `knowledge.tier_not_supported`.

---

## `staticBlocks`

**Use when:** Facts are hand-authored and change with deploys, not at runtime.

```ts
import { defineKnowledgeSource, staticBlocks, createKnowledgeRegistry } from '@plumbus/knowledge-base';

const helpKb = defineKnowledgeSource({
  name: 'help-kb',
  provider: staticBlocks({
    blocks: [
      { text: 'Users can pause interviews.', scope: { audience: 'user' } },
      { text: 'Admins can impersonate support.', scope: { audience: 'admin' } },
      { text: 'Default tip when scope is broad.', scope: {} },
    ],
  }),
});

const registry = createKnowledgeRegistry({ sources: [helpKb] });
await registry.get('help-kb').getBlock(ctx, { audience: 'user' }, { maxTokens: 500 });
```

- Unscoped blocks match any request (wildcard).
- Order matters as tie-breaker after specificity ranking.
- Optional `ranker` replaces default `scopeSpecificityRanker`.

---

## `translationCatalog`

**Use when:** Help text already lives in `app/translations` — avoid duplicating strings in KB config.

```ts
import { translationCatalog } from '@plumbus/knowledge-base';
import { helpTranslations } from '../../app/translations/help.translation.js';

const helpKb = defineKnowledgeSource({
  name: 'help-i18n',
  provider: translationCatalog({
    namespaces: ['help'],
    definitions: [helpTranslations], // enumerates keys; values prefer live ctx.translations
    keyFilter: (key) => !key.startsWith('_'),
  }),
});
```

**When to use `definitions` vs `getCatalog`:**

| Approach | Use when |
|----------|----------|
| `definitions: [helpTranslations, …]` | Keys live in normal Plumbus translation files; you want key enumeration at factory time and live `ctx.translations.t()` when the request locale matches the active context locale |
| `keysByNamespace` only | Tests or minimal catalogs without full `TranslationDefinition` objects — you must list keys explicitly |
| `getCatalog: (locale, ctx) => …` | Catalog comes from DB, CMS, or another service; you own the full namespace → key → string map per call |

**Default resolution (no `getCatalog`):**

1. List keys from `definitions` or `keysByNamespace`.
2. If `scope.locale === ctx.translations.locale` → resolve via `ctx.translations.t(key)`.
3. Else → `createTranslationResolver(definitions).t(locale, key)`.

**Override hook** — bypasses the definitions/resolver path entirely; you must return all namespaces listed in `namespaces`:

```ts
translationCatalog({
  namespaces: ['help'],
  getCatalog: (locale, ctx) => loadCatalogFromDb(locale, ctx),
});
```

Throws `knowledge.translation_unavailable` if namespace or keys are missing.

---

## `capabilityBacked`

**Use when:** Facts are computed from existing read-only business logic.

```ts
import { capabilityBacked } from '@plumbus/knowledge-base';
import { listProductFacts } from '../../capabilities/catalog/list-product-facts.js';

const productKb = defineKnowledgeSource({
  name: 'product-facts',
  provider: capabilityBacked({
    capability: listProductFacts,
    buildInput: (scope) => ({ locale: scope.locale ?? 'en' }),
    format: (output) => output.facts.map((f) => `- ${f}`).join('\n'),
  }),
});
```

**Stricter than chat `capabilityContext`:** rejects capabilities with **any** `data`, `events`, or `external` effects, or `ai !== false`. A cap may work in chat but fail here — by design (knowledge must be read-only).

On capability failure, returns JSON `{ error: "..." }` string (does not throw).

---

## `documentCollection`

**Use when:** Content authors maintain markdown under a directory.

```ts
import { documentCollection } from '@plumbus/knowledge-base';

const docsKb = defineKnowledgeSource({
  name: 'help-docs',
  provider: documentCollection({
    root: './content/help',
    frontmatterParser: (raw) => parseYaml(raw), // optional; simple yaml built-in
  }),
});
```

Example file `content/help/interviews.md`:

```markdown
---
audience: user
locale: en
---

Interview sessions can be paused and resumed.
```

The **built-in** frontmatter parser recognizes only `audience`, `locale`, and `tenantId` (top-level `KnowledgeScope` fields). Other YAML keys are ignored unless you pass `frontmatterParser` to map them — typically into `scope.custom`. Matching then uses the same rules as `staticBlocks`: e.g. request `{ audience: 'user', custom: { projectId: 'memoir-42' } }` matches a block whose parsed scope is `{ audience: 'user', custom: { projectId: 'memoir-42' } }`.

**Operational notes:**

- **Lazy** first read; cached for provider instance lifetime.
- Concurrent first load is promise-memoized.
- Failed first load clears memo so retry works.
- **No file watching** — redeploy or recreate registry to pick up edits.

---

## `ragCorpus`

**Use when:** Content is in a RAG corpus ingested via core (`plumbus rag ingest`).

```ts
import { ragCorpus } from '@plumbus/knowledge-base';

const helpRagKb = defineKnowledgeSource({
  name: 'help-rag',
  provider: ragCorpus({
    corpus: 'help-docs-v1',
    topK: 5,
    minScore: 0.7,
    mapScope: (scope) => ({
      audience: scope.audience,
      locale: scope.locale,
    }),
    queryStrategy: 'fromOpts', // query comes from getBlock opts / chat queryFromTurn
  }),
});
```

**Tier 3 — direct search:**

```ts
const hits = await registry.get('help-rag').search(ctx, 'how to pause interview', {
  audience: 'user',
  locale: 'en',
});
```

**Tier 2 — tools (not executed by chat):**

```ts
const tools = await registry.get('help-rag').getTools(ctx, scope);
// [{ name: 'searchCorpus_help-docs-v1', inputSchema, handler }, ...]
```

`queryStrategy`:

| Value | Query source |
|-------|----------------|
| `'fromOpts'` (default) | `getBlock(..., { query })` or chat `queryFromTurn` |
| `'scopeAsQuery'` | Joins scope fields into a string |
| `(scope) => string` | Custom |

Empty query → tier 1 returns `''` (no retrieve call).

See [rag-via-core.md](./rag-via-core.md) for ingest and filter mapping.

---

## `capabilityBacked` vs chat `capabilityContext`

| Check | `capabilityBacked` | chat `capabilityContext` |
|-------|------------------|-------------------------|
| `data` effects | reject | reject |
| `events` effects | reject | reject |
| `external` effects | reject | allowed |
| `ai` effects | must be `false` | not checked |

---

## Tier 2 tool definitions

KB exports **KB-local** `ToolDefinition` (not core MCP types). Definitions exist for custom agent hosts and future chat versions; `@plumbus/chat@0.1.4` does not invoke them.
