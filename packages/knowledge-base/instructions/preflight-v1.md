# Knowledge Base v1 Preflight Verification

> **Internal engineering record** — v1 implementation QA (2026-05-26). Not consumer documentation. For usage docs see `docs/knowledge-base/` in the Plumbus monorepo.

Date: 2026-05-26
Verifier: implementation agent

## Core symbols

| Symbol | Expected by spec | Actual repo signature | Status | Notes |
|---|---|---|---|---|
| `ctx.ai.retrieve` | `{ corpus?, query, filter?, limit?, minScore? } -> Array<{ content, score, metadata? }>` | `retrieve(config: { query, corpus?, filter?, limit?, minScore?, signal? }): Promise<AIDocument[]>` where `AIDocument` has `content`, `score`, `metadata?` (also `source`) | PASS | `packages/plumbus-core/src/types/context.ts` |
| `executeCapability` | `executeCapability(capability, ctx, input)` | `executeCapability<TInput,TOutput>(capability, ctx, rawInput): Promise<CapabilityResult>` | PASS | `packages/plumbus-core/src/execution/capability-executor.ts`, exported from `@plumbus/core` |
| Capability side-effect metadata | `data`, `events`, `external`, `ai` inspectable on definition | `CapabilityEffects` interface with those fields | PASS | `packages/plumbus-core/src/types/capability.ts` |
| Translation resolver | `ctx.translations.resolver(locale)` with namespace/key access | `TranslationService`: `{ locale, t(key, params?) }` — no `resolver(locale)`; use `createTranslationResolver(definitions)` at provider factory or `getCatalog` hook | PASS | Documented divergence; `translationCatalog` accepts `definitions` or `getCatalog` |
| Core tool exports | checked, not used as KB public tool type in v1 | MCP/tool types exist in core; KB uses KB-local `ToolDefinition` | PASS | Locked in spec |

## Chat symbols

| Symbol/file | Expected by spec | Actual repo shape | Status | Notes |
|---|---|---|---|---|
| `TurnContext` | can add `contextTokenBudget?: number`, `userMessage?: string` | Currently lacks both fields; added in Phase 3 | PASS | `packages/chat/src/types/turn.ts` |
| `run-turn.ts` | has access to effective post-`beforeTurn` user message and chat budget before context resolution | `args.userMessage` used; no `beforeTurn` hook yet — stamp `userMessage` from `args.userMessage` before `resolveContextSources` | PASS | Phase 3 implementation |
| Existing direct-RAG context helper | old helper can be renamed/exported as `ragContext` | `knowledgeContext` in `knowledge-context.ts` wraps `ctx.ai.retrieve` | PASS | Renamed in Phase 8 |
| `ContextSource` | resolver can call registry-backed source and return text item | `ContextSource.resolve` returns `ResolvedContext` with `ContextItem[]` | PASS | |
| `ContextItem` | supports text block context for tier 1 | `kind: 'text' \| 'json'` | PASS | |

## Result

- [x] PASS — implementation may proceed
- [ ] BLOCKED — update this spec before implementation

## Required spec updates, if blocked

- none
