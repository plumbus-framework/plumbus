# Changelog

## 0.1.3

### Changed

- Peer dependency `@plumbus/core` widened to `^0.5.0 <0.7.0` for `@plumbus/core` **0.6.x** compatibility.

## 0.1.2

### Changed

- Peer dependency `@plumbus/core` updated to `^0.5.0 <0.6.0` for the **0.5.0** release.

## 0.1.1

### Documentation

- README ecosystem table lists `@plumbus/api` (partner external API add-on).

## 0.1.0 — 2026-05-26

Initial release.

- Three-tier `KnowledgeProvider` interface (`getBlock`, optional `getTools`, optional `search`)
- `defineKnowledgeSource` + `createKnowledgeRegistry`
- Providers: `staticBlocks`, `translationCatalog`, `capabilityBacked`, `documentCollection`, `ragCorpus` (thin `ctx.ai.retrieve` adapter)
- KB-local `ToolDefinition` (not core MCP re-export)
- Scope bridge `scopeToRetrieveFilter`
- `@plumbus/knowledge-base/testing` helpers
- Consumer documentation in `docs/knowledge-base/` (framework, providers, usage patterns, chat/RAG/testing); `instructions/` trimmed to agent-facing recipes
