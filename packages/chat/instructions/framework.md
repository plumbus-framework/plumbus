# @plumbus/chat — Framework Instructions for AI Agents

This package is the chat primitive for Plumbus apps. Use it when the user wants a multi-turn conversational surface (help bot, support chat, in-product Q&A) with scope guards, budgets, citations, and a streaming UI.

**`package.json` peer (framework releases):** `"@plumbus/core": "0.5.x || 0.6.x"` — copy from `packages/mcp/package.json`; see `packages/plumbus-core/instructions/peer-dependencies.md`. Never use `^0.x` caret ranges.

**Runtime floor:** existing Chat behavior remains **≥ 0.6.11**. Only the optional `policy.toolCalling.ai` per-call provider/model/reasoning override requires core **≥ 0.6.18**; the runtime fails clearly if that field is configured on an older core.

**Do NOT use this package** for: one-shot AI calls (use `defineCapability` + `ctx.ai.generate`), background workflows (use `defineFlow`), or pure RAG search with no chat UI (use `ctx.ai.retrieve` directly).

## Entry Points

| You want to… | Reach for | Lives at |
|---|---|---|
| Declare a new chat | `defineChat({...})` | `@plumbus/chat` barrel |
| Run a turn programmatically | `runChatTurn(ctx, args)` | `@plumbus/chat` |
| Mount the React UI | `useChat()` + `<ChatPanel>` | `@plumbus/chat-ui` |
| Add chat HTTP routes to a Fastify app | `registerChatRoutes(app, routeConfig, chats)` | `@plumbus/chat` |
| Write a chat test | `mockChatRuntime` | `@plumbus/chat/testing` |

## Package Conventions

| Element | Convention | Example |
|---|---|---|
| Chat name | camelCase, descriptive of purpose | `helpChat`, `billingChat`, `onboardingChat` |
| Chat file | one `defineChat` per file | `app/chats/help.chat.ts` |
| Custom prompt name | `<domain>.chat` or `<chat-name>.prompt` | `help.chat`, `billing.chat` |
| Custom context source | name ends in `Context` | `wikiContext`, `userProfileContext` |
| Custom guard | exported as `Guard` type | `const myGuard: Guard = async (ctx, state) => ...` |

## File Map (src/)

If you need to find or extend something, this is where it lives:

| Concern | File |
|---|---|
| `defineChat` schema + validation | `src/define/defineChat.ts` |
| The orchestrator (single source of truth for turn execution) | `src/runtime/run-turn.ts` |
| Event protocol (turn.started, message.delta, etc.) | `src/types/event.ts` + `src/runtime/events.ts` |
| Built-in context sources | `src/context/{knowledge,capability,static,static-from-translations}-context.ts` |
| Context resolver (handles ordering, parallelism, source handles) | `src/context/resolver.ts` |
| Built-in policy guards | `src/policy/*.ts` (each guard in its own file) |
| Guard ordering | `src/policy/registry.ts` (`compilePolicy`) |
| Budget enforcement | `src/budget/enforcer.ts` |
| History window + summarization | `src/history/{window,summarizer}.ts` |
| Persisted entities | `src/session/{entity,turn-entity,pending-action-entity}.ts` |
| Session helpers | `src/session/service.ts` (`createSession`, `appendTurn`, `aggregateForBudget`) |
| HTTP route registration | `src/runtime/http.ts` |
| Generic chat prompt | `src/prompt/chat-turn.prompt.ts` |
| System prompt builder | `src/prompt/build-system-prompt.ts` |
| Provenance issuer + validator | `src/runtime/provenance.ts` |
| Pending action store | `src/runtime/pending-actions.ts` |
| Provider-native tool binding | `src/runtime/bind-tools.ts` |
| Lease-based conversation store | `src/runtime/chat-conversation-store.ts` (+ `src/runtime/in-memory-conversation-store.ts`) |
| Confirm + resume service | `src/runtime/resume-after-confirm.ts` (+ `src/runtime/pending-actions.ts`, `handleConfirm` in `src/runtime/http.ts`) |
| Durable pending action v2 + resume payload | `src/session/pending-action-v2.ts` |
| Tool-calling prompts (re-export into `app/prompts/`) | `src/prompt/chat-tool-round.prompt.ts`, `src/prompt/chat-scope-check.prompt.ts` |

## Cross-Package Composition

`@plumbus/chat` composes on `@plumbus/core` — **do not duplicate core primitives**:

| Concern | Owned by | Use it via |
|---|---|---|
| LLM calls | `@plumbus/core` | `ctx.ai.generate`, `ctx.ai.streamGenerate`, `ctx.ai.generateWithUsage` |
| RAG retrieval | `@plumbus/core` | `ctx.ai.retrieve({ corpus, query, filter })` |
| Capability execution | `@plumbus/core` | `defineCapability`, executed via the standard pipeline |
| Auth / tenant scoping | `@plumbus/core` | inherited via `ExecutionContext` |
| Cost ledger | `@plumbus/core` | tag every chat AI call with `costContext.serviceArea = 'chat'`, `operationName = 'chat.<name>'` (already done by `run-turn.ts`) |
| Entities + migrations | `@plumbus/core` | `defineEntity`, standard Drizzle pipeline |
| Prompts | `@plumbus/core` | `definePrompt` — per-chat overrides plug into AiConfig admin like any other prompt |

## How Agents Should Use This Package

1. **Adding a chat:** see [`defining-chats.md`](./defining-chats.md). Always include `access`. Pick `persistence` mode explicitly. Don't put structured data in `instructions:` — use `staticContext`.
2. **Modifying policies:** see [`policies.md`](./policies.md). Use built-in guards; reach for `policy.custom` only when nothing built-in fits.
3. **Wiring up context:** see [`context-sources.md`](./context-sources.md). Built-in helpers cover most cases; custom `ContextSource` only when truly bespoke.
4. **Writing tests:** see [`testing.md`](./testing.md). Always use `mockChatRuntime`; never spin up a real provider in unit tests.
5. **Extending the framework:** see [`extending.md`](./extending.md). Custom guards, custom context sources, custom prompts.
6. **Provider-native tool calling (Path B):** see [`defining-chats.md`](./defining-chats.md) and [`policies.md`](./policies.md). Staged orchestration requires the package prompt re-exports + `chatRegistry`; custom-prompt agent orchestration with `scopePreflight:false` needs neither.

## Deeper Reference

For the full conceptual documentation (when to use which primitive, design rationale, tradeoffs), see the monorepo docs at `/docs/chat/`:

- `/docs/chat/README.md` — landing page
- `/docs/chat/defining-chats.md` — comprehensive config reference
- `/docs/chat/policies.md` — every policy slot
- `/docs/chat/context-sources.md` — every context source helper
- `/docs/chat/testing.md` — test patterns
- `/docs/chat/evaluations.md` — eval harness (`defineChatEvaluation` / `runChatEvaluation`)
- `/docs/chat/design/` — 11 decision records explaining why the framework is shaped the way it is

The files in this `instructions/` folder are PRESCRIPTIVE (do this, don't do that). The files under `/docs/chat/` are EXPLANATORY (what it is, why it exists). Use both.

## Critical Rules (read before writing chat code)

- **Never bump `@plumbus/chat` without running migrations.** 0.1.11 adds columns to all three chat entities and a **unique** index on `chat_turn (session_id, ordinal)`. After upgrading, run `plumbus generate && plumbus migrate generate && plumbus migrate apply`. The change is additive with no backfill, but the unique index **fails to build** if the existing table already holds duplicate `(session_id, ordinal)` rows — check with `SELECT session_id, ordinal, count(*) FROM chat_turn GROUP BY 1,2 HAVING count(*) > 1` and dedupe first. Full detail: `/docs/chat/confirmation-persistence.md`.
- **Never use a write-effect capability as `capabilityContext`.** The framework rejects it at construction time; if you bypass that, every turn mutates state.
- **Never narrow a staged chat prompt's output schema.** The five base fields (`inScope`, `answer`, `refusalReason`, `citedSources`, `requestedAction`) are required for staged runtime guards. Agent tool orchestration is the explicit exception: it requires a custom plain-text prompt and synthesizes the policy envelope.
- **Never call `runChatTurn` directly from a route.** Use `registerChatRoutes(app, routeConfig, chats)` so SSE, auth, body validation, and `clientHistory` capping are handled correctly.
- **Never store sensitive prose in `ChatTurn.content` without setting `persistence: { messageContent: 'client' }`.** Audit + cross-device hydration are nice but they have privacy implications — pick the mode deliberately.
- **Never invent source IDs in tests or fixtures.** The resolver issues handles (`src_a`, `src_b`, ...) in the order sources are declared in the chat config; cite using those exact strings.
- **Never bypass the action-guard for capability-backed writes.** Configure `policy.action.allowedCapabilities` and let the framework re-validate + confirm. Do not exec capabilities directly from a context source.
- **Never resolve tools with `ctx.capabilities.invoke`.** Chat's tool allowlist is dynamic, so `invoke` throws `undeclaredInvocation`. Tool calling resolves via `ctx.__runtime.resolveCapability(name)` and `executeCapability(cap, ctx, input)` — which still enforces the target's access policy. This is framework internals; do not re-implement it in app code.
- **Complete the setup required by the chosen tool orchestration.** Staged Path B—and agent mode with `scopePreflight:true`—must re-export the package prompts they use and wire `createChatRegistry(promptRegistry)`. Agent orchestration with its default `scopePreflight:false` uses only its custom prompt and needs neither package prompt. Path B still requires durable ChatTurn rows; confirmation-capable deployments require a transactional conversation store.
