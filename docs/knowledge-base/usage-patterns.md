# Usage patterns — five consumer shapes

KB is multi-purpose: same registry, different entry points. Each pattern uses **scope** the same way.

## 1. Chat system prompt (tier 1 via `@plumbus/chat`)

**Goal:** Inject grounded text into every turn.

```ts
import { defineChat, knowledgeContext } from '@plumbus/chat';
import { knowledgeRegistry } from '../knowledge/index.js';

export const helpChat = defineChat({
  context: [
    knowledgeContext({
      registry: knowledgeRegistry,
      source: 'help-kb',
      // default scope: audience, locale, tenantId from TurnContext
    }),
  ],
});
```

RAG-backed source — add `queryFromTurn`. Details: [chat-integration.md](./chat-integration.md).

---

## 2. Capability / tooltip (tier 1 direct)

**Goal:** Short scoped hint without loading chat.

```ts
import { knowledgeRegistry } from '../knowledge/index.js';

export async function getInterviewTooltip(ctx: ExecutionContext, locale: string) {
  return knowledgeRegistry.get('help-kb').getBlock(
    ctx,
    { audience: 'user', locale },
    { maxTokens: 120 },
  );
}
```

Use `staticBlocks` or `translationCatalog` for fixed copy; `capabilityBacked` when the tooltip needs live DB facts.

---

## 3. Semantic search UI (tier 3)

**Goal:** Render a hit list with scores, not a single packed string.

```ts
const hits = await knowledgeRegistry
  .get('help-rag')
  .search(ctx, userQuery, { audience: 'admin', locale: 'en' }, { topK: 20 });

return hits.map((h) => ({
  snippet: h.content,
  score: h.score,
  meta: h.metadata,
}));
```

Requires a provider with `search` (`ragCorpus` or custom). Does not go through chat `knowledgeContext`.

---

## 4. Agent grounding tools (tier 2 — custom host)

**Goal:** Expose `searchCorpus_*` tools to an agent runtime you control.

```ts
const tools = await knowledgeRegistry.get('help-rag').getTools(ctx, scope);
for (const tool of tools) {
  agent.registerTool(tool.name, tool.description, tool.inputSchema, async (args) =>
    tool.handler(args),
  );
}
```

**Not supported in `@plumbus/chat@0.1.4`** — `knowledgeContext({ tier: 'tools' })` throws at construction. Plan for v0.2 or run tools in your own agent loop.

---

## 5. Multi-source chat (static + RAG)

**Goal:** Policy text always present; corpus adds turn-specific hits.

```ts
defineChat({
  context: [
    knowledgeContext({ registry, source: 'help-policy' }), // staticBlocks
    knowledgeContext({
      registry,
      source: 'help-rag',
      queryFromTurn: (t) => t.userMessage ?? '',
    }),
  ],
});
```

**Token budget caveat:** Each source receives the full `turnCtx.contextTokenBudget` independently during resolution. Chat then applies `trimContextToBudget` globally. Size static sources conservatively when pairing with RAG.

---

## Choosing registry vs direct RAG

| Approach | When |
|----------|------|
| `knowledgeContext` + registry | Multiple sources, shared scope, reuse outside chat |
| `ragContext` in chat | Single corpus, no KB package installed |
| Direct `registry.get().search` | Custom UI, no chat |
