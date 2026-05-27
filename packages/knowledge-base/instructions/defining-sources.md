# Defining Knowledge Sources — Agent Recipe

When the user asks you to add registry-backed knowledge, follow this recipe. Full field reference and ranker/packing algorithms: `docs/knowledge-base/defining-sources.md` in the Plumbus monorepo.

## Step-by-step

1. **Pick a kebab-case `name`** — e.g. `help-kb`, `product-rag`. One source per concern.
2. **Choose a provider** — see [providers.md](./providers.md) picker. Do not hand-roll retrieve if `ragCorpus` fits.
3. **Export `defineKnowledgeSource({ name, provider, … })`** from e.g. `app/knowledge/help.knowledge.ts`.
4. **Register in `createKnowledgeRegistry({ sources: [...] })`** at app boot — single frozen export (e.g. `app/knowledge/index.ts`).
5. **Pass registry into consumers** — `knowledgeContext({ registry, source: 'help-kb' })`, capabilities, or tests via `createTestRegistry`.
6. **For `ragCorpus` in chat** — add `queryFromTurn: (t) => t.userMessage ?? ''` on `knowledgeContext` (see [chat-integration.md](./chat-integration.md)).
7. **Align RAG ingest metadata** with `scopeFromTurn` / `mapScope` — filters are flat (`scopeToRetrieveFilter` spreads `custom`).

## Minimal recipe

```ts
// app/knowledge/help.knowledge.ts
import { defineKnowledgeSource, staticBlocks } from '@plumbus/knowledge-base';

export const helpKb = defineKnowledgeSource({
  name: 'help-kb',
  provider: staticBlocks({
    blocks: [{ text: 'Users can pause interviews.', scope: { audience: 'user' } }],
  }),
});

// app/knowledge/index.ts
import { createKnowledgeRegistry } from '@plumbus/knowledge-base';
import { helpKb } from './help.knowledge.js';

export const knowledgeRegistry = createKnowledgeRegistry({ sources: [helpKb] });
```

## Do / Don't

| Do | Don't |
|---|---|
| Freeze registry once at boot | Mutate or extend registry after `createKnowledgeRegistry` |
| Use `createTestRegistry` in tests | Patch globals or skip registry in chat tests |
| Throw `KnowledgeError` with stable codes in custom providers | `throw new Error(...)` for expected failures |
| Set `ranker` when product needs featured/weighted ordering | Reimplement scope filtering incorrectly — start from `scopeSpecificityRanker` |

## Custom provider

Implement `getBlock` at minimum. Optional `getTools` / `search` for tiers 2–3. Wrap with `defineKnowledgeSource`. Use exported `packBlocks` / `scopeSpecificityRanker` when matching built-in behavior.

## Next

- Provider choice: [providers.md](./providers.md)
- Chat: [chat-integration.md](./chat-integration.md)
- Tests: [testing.md](./testing.md)
