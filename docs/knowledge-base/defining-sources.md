# Defining knowledge sources

## `defineKnowledgeSource`

Turns a `KnowledgeProvider` into a named, frozen `KnowledgeSourceDefinition` for the registry.

```ts
import { defineKnowledgeSource, staticBlocks } from '@plumbus/knowledge-base';

export const helpKb = defineKnowledgeSource({
  name: 'help-kb',              // required: lowercase kebab-case
  description: 'In-product help', // optional: docs / codegen
  domain: 'help',                 // optional: grouping label (not enforced)
  provider: staticBlocks({ ... }),
  ranker: myCustomRanker,         // optional: default scopeSpecificityRanker
});
```

Register:

```ts
import { createKnowledgeRegistry } from '@plumbus/knowledge-base';

export const knowledgeRegistry = createKnowledgeRegistry({
  sources: [helpKb, productKb],
});
```

Runtime access:

```ts
const source = knowledgeRegistry.get('help-kb');
const text = await source.getBlock(ctx, { audience: 'user', locale: 'en' }, {
  maxTokens: 800,
  query: 'optional for RAG', // forwarded to provider getBlock opts
});
const hits = await source.search(ctx, 'billing', scope, { topK: 10 });
const tools = await source.getTools(ctx, scope);
```

## Field reference

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` — e.g. `help-kb`, not `Help_KB` |
| `provider` | yes | Must implement `getBlock` |
| `description` | no | Human-readable; not used at runtime |
| `domain` | no | Convention for grouping sources in app code |
| `ranker` | no | `(blocks, scope) => blocks`; default `scopeSpecificityRanker` |

## Validation behavior

Failures throw `knowledge.define_invalid`:

- Empty or missing `name`
- Name not kebab-case
- Provider missing `getBlock`

On success the definition is **deep-frozen** (`Object.freeze` recursively).

**Tier-1-only warning:** If the provider has neither `getTools` nor `search`, a **one-time** `console.warn` per source name notes tier 1 only. Not an error.

**Registry validation:** Duplicate `name` in `createKnowledgeRegistry` throws `knowledge.duplicate_source`. Unknown name on `get()` throws `knowledge.source_not_found`.

**Registry freezing:** `createKnowledgeRegistry` deep-freezes definitions and the registry. No runtime add/remove/merge — build a new registry at boot (or in tests via `createTestRegistry`). See [README.md → Registry freezing](./README.md#registry-freezing-and-composition).

## Static vs dynamic contracts

| Provider style | When scope is validated | When content loads |
|----------------|-------------------------|-------------------|
| **Static** (`staticBlocks`) | At factory time (blocks listed upfront) | At factory time |
| **Dynamic** (`documentCollection`, `ragCorpus`, `capabilityBacked`) | At `getBlock` / `search` time | Lazy (per call or memoized) |

Static providers filter blocks with `filterBlocksByScope` then rank. Dynamic providers apply scope when resolving (RAG via `filter`, docs via frontmatter).

## Rankers and packing

### `scopeSpecificityRanker` and `filterBlocksByScope`

Both are exported from `@plumbus/knowledge-base`.

**`filterBlocksByScope`** keeps blocks whose scope matches the request:

- For each of `audience`, `locale`, `tenantId`: if the block sets the field, it must equal the request; if unset on the block, any request value matches.
- For `custom`: every key on the block's `custom` must exist on the request with the same value (`requested.custom?.[key] === value`). Extra keys on the request do not disqualify a block.

**`scopeSpecificityRanker`** runs `filterBlocksByScope`, then sorts by:

1. **Specificity score** — count of "matching dimensions": each of `audience` / `locale` / `tenantId` where both sides are set and equal counts +1; each `custom` key on the block where `requested.custom[key] === value` counts +1. Higher score ranks first.
2. **Tie-break** — higher block `score` wins.

`custom` keys are weighted the same as `audience` (one point per matched key, not weighted by importance).

### `packBlocks` and `estimateTokens`

**`estimateTokens(text)`** — `Math.ceil(text.length / 4)` (character heuristic, not a tokenizer).

**`packBlocks(blocks, maxTokens?)`** — greedy first-fit in **rank order** (input order after ranking):

- Join selected blocks with `\n\n` (each separator costs 1 token in the budget).
- Walk blocks in order; append the next block only if `used + separator + blockTokens <= maxTokens`.
- **Overflow** — remaining blocks are dropped (not truncated mid-block).
- If `maxTokens` is omitted or `<= 0`, concatenates **all** blocks with no limit.

Built-in tier-1 providers call rank → `packBlocks` unless they implement their own packing.

## Ranker override

Default ranker is `scopeSpecificityRanker` as described above.

```ts
import { scopeSpecificityRanker, type ScoredBlock, type KnowledgeScope } from '@plumbus/knowledge-base';

function preferFeatured(blocks: ScoredBlock[], scope: KnowledgeScope): ScoredBlock[] {
  const ranked = scopeSpecificityRanker(blocks, scope);
  return [...ranked].sort((a, b) => {
    const af = a.metadata?.featured === true ? 1 : 0;
    const bf = b.metadata?.featured === true ? 1 : 0;
    return bf - af;
  });
}

defineKnowledgeSource({
  name: 'featured-help',
  provider: staticBlocks({ blocks: [...], ranker: preferFeatured }),
});
```

Source-level `ranker` on `defineKnowledgeSource` applies when the registry wraps the provider (same hook point as provider-level ranker on `staticBlocks` / `documentCollection`).

## Custom provider walkthrough

Implement the interface from `@plumbus/knowledge-base`:

```ts
import type { KnowledgeProvider, KnowledgeScope } from '@plumbus/knowledge-base';
import type { ExecutionContext } from '@plumbus/core';

export function cmsPages(opts: { apiUrl: string }): KnowledgeProvider {
  return {
    async getBlock(ctx: ExecutionContext, scope: KnowledgeScope, { maxTokens, query } = {}) {
      const pages = await fetchPages(opts.apiUrl, scope);
      const text = pages.map((p) => p.title + '\n' + p.body).join('\n\n');
      // apply your own token limit if needed
      return text.slice(0, (maxTokens ?? 2000) * 4);
    },
    // omit getTools / search if tier 1 only
  };
}

export const cmsKb = defineKnowledgeSource({
  name: 'cms-pages',
  provider: cmsPages({ apiUrl: process.env.CMS_URL ?? '' }),
});
```

**Rules of thumb:**

- Use `ctx` for request-bound services (`data`, `ai`, `translations`, `auth`).
- Do not mutate global state; memoize inside the factory closure if needed (`documentCollection` pattern).
- Throw `KnowledgeError` with stable codes for expected failures.

## `KnowledgeProvider` shape

```ts
interface KnowledgeProvider {
  getBlock(
    ctx: ExecutionContext,
    scope: KnowledgeScope,
    opts?: { maxTokens?: number; query?: string },
  ): Promise<string>;

  getTools?(ctx: ExecutionContext, scope: KnowledgeScope): Promise<ToolDefinition[]>;

  search?(
    ctx: ExecutionContext,
    query: string,
    scope: KnowledgeScope,
    opts?: { topK?: number },
  ): Promise<SearchResult[]>;
}
```

`getBlock` is mandatory. Optional methods should throw `knowledge.tier_not_supported` if you want callers to detect absence — built-in tier-1-only providers do this consistently.

## Next steps

- Pick a built-in provider: [providers.md](./providers.md)
- Wire chat: [chat-integration.md](./chat-integration.md)
- Test: [testing.md](./testing.md)
