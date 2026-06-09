# @plumbus/knowledge-base

> **Audience-scoped, queryable knowledge for [Plumbus](https://github.com/plumbus-framework/plumbus) apps.** One provider contract, multiple content backends, composed through an explicit registry — so chat, tooltips, capabilities, and admin search all see the same facts under the same scope rules.

[![npm](https://img.shields.io/npm/v/@plumbus/knowledge-base.svg)](https://www.npmjs.com/package/@plumbus/knowledge-base)
[![license](https://img.shields.io/npm/l/@plumbus/knowledge-base.svg)](./LICENSE)
[![peer: @plumbus/core ^0.4](https://img.shields.io/badge/peer-%40plumbus%2Fcore%20%5E0.4-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/chat 0.1.x](https://img.shields.io/badge/peer-%40plumbus%2Fchat%200.1.x-blue)](https://www.npmjs.com/package/@plumbus/chat)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. You declare your app's primitives — capabilities, entities, events, flows, prompts, translations — through `define*()` functions; the framework generates routes, validation, audit, security, and types.

`@plumbus/knowledge-base` adds a **knowledge primitive** on top of that contract. Instead of every feature calling `ctx.ai.retrieve` directly or duplicating i18n strings, you declare named knowledge sources once and reference them from chat, capabilities, tooltips, agent runtimes, and admin search — all under the same `{ audience, locale, tenantId, custom? }` scope rules.

If you're not using Plumbus, this package can't be used in isolation. The providers compose on the framework's `ExecutionContext`, `ctx.ai.retrieve`, `ctx.translations`, and the capability registry.

## Why?

If you've grown past one chat using one RAG corpus, you've probably hit:

- The same scoped facts duplicated across chat, tooltip, and email templates
- One-off retrieve calls scattered through capabilities — each with its own filter logic
- Admin docs leaking to user-facing surfaces because there's no central scope policy
- i18n strings cloned into RAG corpora for translation purposes

This package gives you a single answer: declare each knowledge source once with a `KnowledgeProvider`, compose them at boot into a frozen registry, and pass the registry to every feature that needs scoped knowledge.

## What you get

| Surface | What it does |
|---|---|
| `defineKnowledgeSource({ name, provider, ranker? })` | Wrap a provider into a named, deeply-frozen source. |
| `createKnowledgeRegistry({ sources })` | Compose sources at boot. Frozen — no runtime add/remove. |
| **Three tiers** on each source | `getBlock` → injectable text (tier 1) · `getTools` → agent tool definitions (tier 2) · `search` → structured `SearchResult[]` (tier 3) |
| `staticBlocks`, `translationCatalog`, `capabilityBacked`, `documentCollection`, `ragCorpus` | Five built-in providers — hand-authored facts, i18n catalogs, live capability output, markdown trees, RAG corpora. |
| `KnowledgeScope` | `{ audience?, locale?, tenantId?, custom? }` — scope drives both filtering (which blocks are visible) and ranking (specificity). |
| `scopeSpecificityRanker`, `filterBlocksByScope`, `packBlocks`, `estimateTokens` | Public helpers for custom providers. |
| Chat integration | `knowledgeContext({ registry, source })` in `@plumbus/chat` consumes any registered source as a chat context provider. |
| Test helpers (`@plumbus/knowledge-base/testing`) | `mockKnowledgeSource`, `createTestRegistry`, `expectKnowledgeCalled` for vitest. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Single corpus, single chat, no reuse anywhere else | `ragContext({ corpus, query })` in `@plumbus/chat` (no registry needed) |
| One-off `ctx.ai.retrieve` in a single capability | Direct retrieve call |
| **Multiple features sharing the same scoped facts** | **`@plumbus/knowledge-base`** (this package) |
| i18n-aligned help text that the chat should ground in | `translationCatalog` provider here |
| Markdown tree as the knowledge source | `documentCollection` provider here |
| Admin search UI over the same corpus chat uses | `registry.get(...).search(ctx, query, scope)` (tier 3) |

## Status

Optional peer of `@plumbus/chat` (version-locked `0.1.x`). Implements the `defineKnowledgeSource` / registry contract, all five built-in providers, the scope model, and the chat `knowledgeContext` integration. Auto-discovery, file watching for `documentCollection`, governance hooks, and chat tier-2 tool execution are not implemented — see [Out of scope](#out-of-scope).

## Install

```bash
pnpm add @plumbus/knowledge-base
```

Peers:
- `@plumbus/core` `^0.4.0 <0.5.0` — required (`ctx`, RAG, capabilities, translations)
- `@plumbus/chat` `^0.1.4 <0.2.0` — required only if you wire knowledge into chat via `knowledgeContext`

## Quickstart

```ts
import {
  createKnowledgeRegistry,
  defineKnowledgeSource,
  staticBlocks,
} from '@plumbus/knowledge-base';

export const helpKb = defineKnowledgeSource({
  name: 'help-kb',
  description: 'In-product help facts',
  provider: staticBlocks({
    blocks: [
      { text: 'Interview pages support AI-assisted Q&A.', scope: { audience: 'user' } },
      { text: 'Admin ops runbooks live here.', scope: { audience: 'admin' } },
    ],
  }),
});

export const knowledgeRegistry = createKnowledgeRegistry({ sources: [helpKb] });

// Tier 1 (inject text into a chat, tooltip, or email):
const block = await knowledgeRegistry
  .get('help-kb')
  .getBlock(ctx, { audience: 'user', locale: 'en' }, { maxTokens: 500 });
```

Wire into chat (`@plumbus/chat@0.1.4+`):

```ts
import { knowledgeContext } from '@plumbus/chat';

defineChat({
  context: [knowledgeContext({ registry: knowledgeRegistry, source: 'help-kb' })],
});
```

## Providers — pick one per source

| Provider | Best when | Tiers |
|---|---|---|
| `staticBlocks` | Hand-authored facts in code or config | 1 |
| `translationCatalog` | Content already lives in `app/translations` (`definitions` or `getCatalog` hook) | 1 |
| `capabilityBacked` | Facts are computed by a **read-only** capability | 1 |
| `documentCollection` | Markdown tree with optional YAML frontmatter scope | 1 |
| `ragCorpus` | Embeddings corpus via `ctx.ai.retrieve` / `plumbus rag ingest` | 1, 2, 3 |

Only `getBlock` (tier 1) is required on a provider. `ragCorpus` implements all three; the others are tier 1 only.

## Key gotchas

- **The registry is frozen at construction.** No runtime add/remove. To change sources, build a new registry (typically at app boot) and pass that to consumers.
- **Scope filtering uses wildcards on unset dimensions.** A block with `scope: { audience: 'admin' }` doesn't match `{ audience: 'user' }`, but a block with no audience matches both.
- **RAG ingest stays in core.** `plumbus rag ingest` only. KB's `ragCorpus` calls `ctx.ai.retrieve` — there is no separate `plumbus knowledge ingest` command.
- **`capabilityBacked` rejects write-effect capabilities at construction.** Use it only for `kind: 'query'` capabilities with `effects: { data: [], events: [], external: [], ai: false }`.
- **Chat tier-2 tools are NOT executed in `@plumbus/chat@0.1.4`.** `knowledgeContext({ tier: 'tools' })` throws at construction. Use tier 1 for chat; reserve tier 2 for custom agent runners you build yourself.

## Documentation

- **Concepts and reference** (in the monorepo): [`docs/knowledge-base/`](../../docs/knowledge-base/)
  - [`README.md`](../../docs/knowledge-base/README.md) — registry semantics, scope, tiers, result types
  - [`defining-sources.md`](../../docs/knowledge-base/defining-sources.md) — `defineKnowledgeSource`, rankers, `packBlocks` algorithm
  - [`providers.md`](../../docs/knowledge-base/providers.md) — all five built-in providers
  - [`usage-patterns.md`](../../docs/knowledge-base/usage-patterns.md) — chat, tooltip, search UI, agent tools, multi-source
  - [`chat-integration.md`](../../docs/knowledge-base/chat-integration.md) — `knowledgeContext` vs `ragContext`
  - [`rag-via-core.md`](../../docs/knowledge-base/rag-via-core.md) — ingest → retrieve pipeline
  - [`testing.md`](../../docs/knowledge-base/testing.md) — `@plumbus/knowledge-base/testing` helpers
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/knowledge-base/instructions/`):
  - [`instructions/conventions.md`](./instructions/conventions.md) — conventions, file map, critical rules
  - [`instructions/defining-sources.md`](./instructions/defining-sources.md) — recipe for adding a source
  - [`instructions/providers.md`](./instructions/providers.md) — provider picker
  - [`instructions/chat-integration.md`](./instructions/chat-integration.md) — wire registry-backed `knowledgeContext`
  - [`instructions/testing.md`](./instructions/testing.md) — test patterns

## The Plumbus ecosystem

| Package | Purpose | When to install |
|---|---|---|
| [`@plumbus/core`](../plumbus-core/) | Foundation — capabilities, entities, events, flows, prompts, translations, runtime, CLI, audit, governance. | Always (required). |
| [`@plumbus/ui`](../ui/) | Next.js/React UI — typed API clients, auth helpers, form metadata, scaffolds. | When building a Plumbus web UI. |
| [`@plumbus/api`](../api/) | Partner external API — manifest, OpenAPI, docs, compatibility diff, test intent. | Optional peer `0.1.x` — when publishing a documented partner-facing HTTP API. |
| [`@plumbus/mcp`](../mcp/) | MCP runtime — serve capabilities to AI agents (`tools/*`, `tasks/*`, transports). | Optional peer `0.4.x` — when exposing capabilities to MCP clients. |
| [`@plumbus/chat`](../chat/) | Conversational runtime — `defineChat`, policy guards, context sources, streamed events. | Optional peer `0.1.x` — when adding a chat surface (required if wiring `knowledgeContext`). |
| [`@plumbus/chat-ui`](../chat-ui/) | React chat UI — hooks and `<ChatPanel />` for the `@plumbus/chat` turn protocol. | Peer of `@plumbus/chat` — when adding a browser chat client. |
| **`@plumbus/knowledge-base`** | **You are here.** Knowledge providers — scoped sources, registry, chat `knowledgeContext` integration. | Optional peer of `@plumbus/chat` `0.1.x` — when sharing named knowledge across features. |
| [`@plumbus/browser-extension`](../browser-extension/) | Extension scaffolder — WXT Chrome/Firefox project wired to your capabilities. | With `@plumbus/ui` (`0.1.x`) — when shipping a browser extension UI. |

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## Out of scope

Not implemented: auto-discovery of sources, file watching for `documentCollection`, governance hooks, `databaseCollection` provider, hybrid retrieval, chat tier-2 tool execution.

## License

MIT
