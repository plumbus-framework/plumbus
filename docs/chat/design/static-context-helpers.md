# Static context helpers

> **Locked.** Two helpers: `staticContext` and `staticContextFromTranslations`.

## The problem

The chat design's context-source model started with two named helpers:

- `knowledgeContext` — RAG over a corpus, expensive per turn.
- `capabilityContext` — calls a capability per turn, live data.

Neither fits "tiny structured data that should always be in the prompt":

- A path-to-page map (`/project` → "Project page", `/timeline` → "Timeline page") — 200 bytes of constant strings the model needs every turn.
- A glossary of product terms.
- A short table of status meanings.

Forcing these through `knowledgeContext` is overkill — embedding 200 bytes is silly. Forcing them through `capabilityContext` requires writing a no-op capability. Most consumers will jam them into `instructions: [...]` (the system prompt body), which works but bloats the prompt and offers no provenance.

A parallel observation: i18n catalogs (`app/translations/`) already contain product surface names. Hardcoding them into a `staticContext` recreates a drift problem — rename a button in the translation catalog, the chat keeps using the old name.

## How it works

Two built-in helpers join `knowledgeContext` and `capabilityContext`:

**`staticContext`** — inline structured items, no retrieval, no LLM, no cost beyond the inlined content:

```ts
staticContext({
  id?: string;
  items: ContextItem[];
  sourceId?: string;
  includeIf?: (turnCtx) => boolean;
  format?: 'list' | 'table' | 'paragraphs';
})
```

Items are rendered into the prompt under a runtime-issued source handle, just like any other context source. They count against `budget.contextTokens` and can be cited by the model.

**`staticContextFromTranslations`** — convenience wrapper that builds `staticContext` items from `ctx.translations`:

```ts
staticContextFromTranslations({
  namespaces: ['nav', 'admin.nav'];
  keyFilter?: (key) => boolean;
  sourceId?: string;
})
```

At resolve time it walks the matching translation keys for `turnCtx.locale` and produces one item per key-value pair. Surface name renames in the i18n catalog automatically flow into the chat.

## Tradeoffs

**What works well:**
- Closes a real gap — small structured knowledge has a home that isn't `instructions:` and isn't a no-op capability.
- `staticContextFromTranslations` eliminates a class of bugs MemoirAI hit repeatedly during help-bot iteration.
- Both go through the standard `ContextSource` interface, so provenance, budgets, and trace recording work uniformly.

**What you give up:**
- Three built-in helpers instead of two — slightly more API surface to remember.
- `staticContext` items count against context-token budget. Apps that abuse it (dumping 50KB of "static" data) hit the trim threshold and lose other context first — knowledge items get dropped before static items.
- `staticContextFromTranslations` couples chats to the i18n layer. Consumers without translations need to use `staticContext` directly.

## Implementation note

The resolver issues source handles in the order sources are declared. A `staticContext` declared first gets `src_a`, the next source `src_b`, etc. Order matters for stable citations across turns and across releases.

---

## Addendum (2026-07-08)

**`staticContextFromTranslations`:** Deprecated in `@plumbus/chat` (removal target v0.2). It does not read `ctx.translations`; without an explicit `getCatalog(locale)` callback it resolves zero items. Prefer `@plumbus/knowledge-base` `translationCatalog` + registry `knowledgeContext`.
