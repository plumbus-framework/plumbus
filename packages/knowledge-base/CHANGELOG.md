# Changelog

## 0.1.0 — 2026-05-26

Initial release.

- Three-tier `KnowledgeProvider` interface (`getBlock`, optional `getTools`, optional `search`)
- `defineKnowledgeSource` + `createKnowledgeRegistry`
- Providers: `staticBlocks`, `translationCatalog`, `capabilityBacked`, `documentCollection`, `ragCorpus` (thin `ctx.ai.retrieve` adapter)
- KB-local `ToolDefinition` (not core MCP re-export)
- Scope bridge `scopeToRetrieveFilter`
- `@plumbus/knowledge-base/testing` helpers
- Consumer documentation in `docs/knowledge-base/` (framework, providers, usage patterns, chat/RAG/testing); `instructions/` trimmed to agent-facing recipes
