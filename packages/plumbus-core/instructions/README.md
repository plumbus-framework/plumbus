# @plumbus/core — Agent Instructions

This folder ships with the npm tarball. It is the entry point for AI coding agents working in a Plumbus consumer app. Read these files when implementing framework primitives, CLI workflows, security, testing, or optional add-on integration.

For conceptual reference, see `docs/` in the Plumbus monorepo. These files are **prescriptive** (do this, don't do that).

| File | When to read |
|------|--------------|
| [guardrails.md](./guardrails.md) | First. Framework-first rules, forbidden escape hatches, git safety. |
| [framework.md](./framework.md) | Core abstractions, `ctx`, consumption surfaces, project layout, server hooks. |
| [capabilities.md](./capabilities.md) | `defineCapability()`, kinds, access, effects, MCP/API exposure. |
| [entities.md](./entities.md) | `defineEntity()`, fields, classification, tenant scoping. |
| [events.md](./events.md) | `defineEvent()`, outbox pattern, consumers. |
| [flows.md](./flows.md) | `defineFlow()`, steps, triggers, retries. |
| [prompts.md](./prompts.md) | `definePrompt()`, `system`/`description`, model resolution. |
| [ai.md](./ai.md) | `ctx.ai` operations (incl. provider-native tool calling + `runToolLoop`), cost tracking, env-based provider config. |
| [translations.md](./translations.md) | `defineTranslation()`, `ctx.translations`. |
| [security.md](./security.md) | Access policies, tenant isolation, auth adapters. |
| [governance.md](./governance.md) | Advisory rules, `plumbus verify`, compliance profiles. |
| [testing.md](./testing.md) | `runCapability`, `simulateFlow`, `mockAI`, security asserts. |
| [patterns.md](./patterns.md) | Naming conventions, do's/don'ts, common recipes. |
| [cli.md](./cli.md) | CLI commands (dev, migrate, generate, test, etc.). |
| [mcp.md](./mcp.md) | Core MCP surface (`exposeAs`, `plumbus mcp *`). |
| [api.md](./api.md) | Core partner API surface (`exposeAs: ['api']`). |
| [deployment.md](./deployment.md) | Production deployment, workers, health, env vars. |
| [peer-dependencies.md](./peer-dependencies.md) | **Before editing add-on `peerDependencies`** — copy literals exactly. |
| [upgrading-0.5-capabilities.md](./upgrading-0.5-capabilities.md) | Canonical capability names, invoke policy, flow auth snapshot. |

Optional AI provider: after `pnpm add @plumbus/ai-bedrock`, read `node_modules/@plumbus/ai-bedrock/instructions/README.md` (framework + pricing pull).

Package quickstart: [../README.md](../README.md).

## Critical rules

- **Primitives are mandatory architecture** — business logic belongs in capabilities, flows, entities, events, prompts, and translations.
- **Use `ctx.*` subsystems** — do not bypass the framework with ad hoc infrastructure unless documented.
- **Never edit `.plumbus/generated/`** — regenerate with `plumbus generate`.
- **Do not install framework-provided deps** — import Zod from `@plumbus/core/zod`; run tests with `plumbus test`.
- **Mock AI by operation** — `mockAI({ generate, extract, classify, retrieve })`, not by prompt name.
- **MCP tool names are canonical** — `<domain>.<name>` (e.g. `billing.getRefund`).
