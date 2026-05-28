# @plumbus/knowledge-base — Agent Instructions

This folder ships with the npm tarball and is the entry point for AI coding agents working in apps that depend on `@plumbus/knowledge-base`. Read these files when you need to add, modify, or wire knowledge sources.

| File | When to read |
|---|---|
| [`conventions.md`](./conventions.md) | First. Package conventions, file map, critical rules. |
| [`defining-sources.md`](./defining-sources.md) | Adding a new `defineKnowledgeSource` + registry entry. |
| [`providers.md`](./providers.md) | Picking `staticBlocks` vs `ragCorpus` vs other built-ins. |
| [`chat-integration.md`](./chat-integration.md) | Wiring `knowledgeContext` in `defineChat`. |
| [`testing.md`](./testing.md) | `mockKnowledgeSource`, `createTestRegistry`, spies. |

These files are **prescriptive** (do this, don't do that). For **conceptual** reference (three tiers, scope, rankers, registry freezing, `ScoredBlock` vs `SearchResult`), see `docs/knowledge-base/` in the Plumbus monorepo.

When the user asks "how should I use KB for X" (chat grounding, tooltip, search UI, agent tools, multi-source), start with the five entry-point shapes in `docs/knowledge-base/usage-patterns.md` (in the Plumbus monorepo) — it shows the call-site shape for each case, then cross-references the specific recipe file here.

Internal v1 implementation QA: [`preflight-v1.md`](./preflight-v1.md) — not consumer documentation.

Package quickstart: [../README.md](../README.md).
