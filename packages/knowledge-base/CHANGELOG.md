# Changelog

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the npm `beta` dist-tag. Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.8.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

## 0.2.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.2.0.

## 0.2.0 — 2026-09-10

### Upgrade boundary

- Join the coordinated core 0.7.x release family with updated Plumbus peer dependencies. This is a new minor line so legacy caret updates cannot silently select it. Runtime APIs in this package are unchanged.
- Update all installed Plumbus packages together; packages publish to npm’s default `latest` dist-tag. Read the [security release migration checklist](../../docs/upgrading-security-release.md) and run `plumbus init --patch` for agent wiring v16.

## 0.1.5

### Behavior fixes

- **K13 — Source-level ranker:** Precedence is provider-factory explicit ranker → `defineKnowledgeSource({ ranker })` → default `scopeSpecificityRanker`. Source-level rankers apply when the provider factory omits an explicit ranker.
- **K14 — `mockKnowledgeSource` scope:** Optional `scope` is stored on `KnowledgeSourceDefinition.scope` for test metadata.
- **K15 — Forbidden-import test:** `no-vector-store-imports.test.ts` enforces the thin-adapter boundary in CI.

## 0.1.4

### Changed

- Peer dependency `@plumbus/core` corrected to `0.5.x || 0.6.x` so npm accepts `@plumbus/core` **0.6.x** (`^0.5.0 <0.7.0` only matched 0.5.x under npm semver).

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
