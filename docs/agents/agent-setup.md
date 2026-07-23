# AI Agent Integration

This guide explains how to configure AI coding agents (GitHub Copilot, Cursor, Windsurf, etc.) to understand the Plumbus framework and generate correct code.

## Mandatory Guardrails

`plumbus init` does more than point agents at reference docs. It also generates project wiring that tells agents:

- Plumbus primitives are mandatory architecture for business logic.
- `ctx.*` subsystems should be used instead of bypassing the framework with ad hoc infrastructure code.
- Destructive git commands require explicit user approval before they run.

See [docs/agents/guardrails.md](guardrails.md) for the full policy and for the difference between instruction-based guidance and hard enforcement.

## Quick Setup

```bash
# Initialize agent wiring (picks best format automatically)
plumbus init

# Or specify the agent
plumbus init --agent copilot
plumbus init --agent cursor
plumbus init --agent agents-md

# Refresh only Plumbus-managed sections
plumbus init --patch

# Preview a patch before writing it
plumbus init --patch --dry-run
```

That's it. Your AI agent now understands Plumbus conventions.

By default, `plumbus init` is non-destructive: it creates missing wiring files and skips existing ones. Use `plumbus init --patch` to update Plumbus-managed sections in generated files while preserving surrounding custom notes. Use `plumbus init --force` only when you want to replace an existing generated file outright.

After upgrading `@plumbus/core`, prefer `plumbus init --patch` first. If doctor reports an old or unmanaged file that cannot be patched safely, use `plumbus init --force` for that full refresh.

## How It Works

```
plumbus init
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│ Reads instruction files from:                               │
│ node_modules/@plumbus/core/instructions/                    │
│ node_modules/@plumbus/ui/instructions/                      │
│ node_modules/@plumbus/chat/instructions/                    │
│ node_modules/@plumbus/chat-ui/instructions/                 │
│ node_modules/@plumbus/knowledge-base/instructions/          │
│ node_modules/@plumbus/voice/instructions/                   │
│ node_modules/@plumbus/mcp/instructions/                     │
│ node_modules/@plumbus/api/instructions/                     │
│ node_modules/@plumbus/auth/instructions/                    │
│ node_modules/@plumbus/auth-cognito/instructions/            │
│ node_modules/@plumbus/browser-extension/instructions/       │
│                                                             │
│  guardrails.md    ← Mandatory architecture + git safety     │
│  framework.md     ← Core patterns and conventions           │
│  cli.md, mcp.md, api.md ← Core consumption surfaces         │
│  prompts.md       ← Prompt content (system/description)     │
│  nextjs-template.md ← Frontend scaffolding guidance         │
│  capabilities.md  ← How to write capabilities               │
│  entities.md      ← How to define entities                  │
│  events.md        ← How to define and emit events           │
│  flows.md         ← How to build multi-step flows           │
│  ai.md            ← How to use AI features                  │
│  security.md      ← Access policies and tenant isolation    │
│  governance.md    ← Governance rules and compliance         │
│  testing.md       ← Testing helpers and patterns            │
│  patterns.md      ← Common code patterns                    │
│  chat/*.md        ← Recipes for defineChat, guards,         │
│                     context sources, testing, extending     │
│  knowledge-base/*.md ← KB conventions, sources, providers,  │
│                     chat wiring, testing (when installed)     │
│  api/*.md           ← Partner API expose, manifest, CLI,    │
│                     testing (when @plumbus/api installed)   │
│  auth/*.md          ← OIDC runtime, sessions, CSRF, Cognito │
│                     (when @plumbus/auth installed)          │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ Generates wiring file for   │
              │ your chosen agent format    │
              └─────────────────────────────┘
```

## Agent Formats

### GitHub Copilot

```bash
plumbus init --agent copilot
```

Creates `.github/copilot-instructions.md` — automatically loaded by GitHub Copilot in VS Code and GitHub.com.

### Cursor

```bash
plumbus init --agent cursor
```

Creates `.cursor/rules/plumbus.mdc` and `.cursor/rules/plumbus-capabilities.mdc` — loaded by Cursor as project rules (generated together by `plumbus init`).

### AGENTS.md

```bash
plumbus init --agent agents-md
```

Creates `AGENTS.md` at the project root — a generic format supported by multiple agents.

## What Agents Learn

After initialization, your AI agent understands:

| Topic | Knowledge |
|-------|-----------|
| **Framework** | Plumbus primitives, project structure, naming conventions |
| **Guardrails** | Framework-first implementation, forbidden escape hatches, destructive git safety |
| **Capabilities** | How to use `defineCapability()`, all 4 kinds, handler patterns |
| **Entities** | How to use `defineEntity()`, field types, classification |
| **Events** | How to use `defineEvent()`, outbox pattern, consumers |
| **Flows** | How to use `defineFlow()`, step types, state machines |
| **AI** | How to use `definePrompt()`, providers, RAG, cost controls |
| **Security** | Access policies, tenant isolation, deny-by-default |
| **Governance** | Built-in rules, compliance profiles, overrides |
| **Testing** | `runCapability()`, `simulateFlow()`, `mockAI()`, security asserts |
| **Patterns** | Common implementation patterns and idioms |
| **UI Generation** | How to generate clients, hooks, auth helpers, form hints, and Next.js scaffolds |
| **Chat** | How to define chats, configure guards, pick context sources, test, and extend the runtime |
| **Knowledge base** | How to define knowledge sources, pick providers, wire `knowledgeContext`, and test registries (when `@plumbus/knowledge-base` is installed) |
| **Partner API** | How to expose capabilities with `exposeAs: ['api']`, maintain `api.yaml`, generate OpenAPI, and test partner routes (when `@plumbus/api` is installed) |
| **OIDC auth** | How to wire `createAuthRuntime`, server sessions, CSRF, resolvers, and Cognito (when `@plumbus/auth` is installed) |
| **Voice** | How to define voices, wire STT/TTS providers, and secure voice routes (when `@plumbus/voice` is installed) |
| **Browser extension** | How to scaffold a WXT extension wired to capabilities (when `@plumbus/browser-extension` is installed) |

## Manual Setup

If you prefer not to use the CLI, create the files manually:

### GitHub Copilot

Create `.github/copilot-instructions.md`:

```markdown
# Plumbus Framework Instructions

This project uses the Plumbus framework. Follow these conventions:

## Guardrails
- Implement business logic through Plumbus primitives, not ad hoc controllers or service layers
- Use `ctx.*` subsystems instead of bypassing the framework with direct infrastructure code
- Never run destructive git commands without explicit user approval

## Capabilities
- Use `defineCapability()` from `@plumbus/core`
- Kinds: query (GET), action (POST), job (async), eventHandler
- Always declare `access` and `effects`
- Use `ctx.data`, `ctx.events`, `ctx.ai` in handlers

## Entities
- Use `defineEntity()` with `field.*` constructors
- Set `classification` on fields containing user data
- Use `tenantScoped: true` for multi-tenant data

## Testing
- Import from `@plumbus/core/testing`
- Use `runCapability()` for unit tests
- Use `simulateFlow()` for flow tests
- Always test security with `assertAccessDenied()`

See node_modules/@plumbus/core/instructions/ for full details.
```

### Cursor

Create `.cursor/rules/plumbus.mdc`:

```markdown
---
description: Plumbus Framework rules
globs: ["**/*.ts"]
---

# Plumbus Framework

## Guardrails
- Use Plumbus primitives for business logic instead of custom routes, controllers, or service layers
- Ask which Plumbus extension point to use if the architecture is unclear
- Never run destructive git commands without explicit user approval

Use `defineCapability()`, `defineEntity()`, `defineEvent()`, `defineFlow()`,
`definePrompt()` from `@plumbus/core`.

Always declare access policies. Use `@plumbus/core/testing` for tests.
See `node_modules/@plumbus/core/instructions/` for complete guidelines.
```

## Project Briefs

For deeper context, generate project briefs:

```bash
# Print a brief for a specific resource (stdout only)
plumbus agent brief capability getUser
plumbus agent brief entity User

# Write the aggregate project brief to disk
plumbus agent sync
```

`agent brief` supports **capabilities** and **entities** only (not flows) and prints to stdout. `agent sync` writes `.plumbus/briefs/project.md` with aggregate context for AI agents.

## Inline Mode

For smaller projects or agents that work better with inline instructions:

```bash
plumbus init --agent copilot --inline
```

This embeds the full instruction content directly into the wiring file instead of referencing `node_modules/` paths.

## Instruction File Locations

| Path | Content |
|------|---------|
| `node_modules/@plumbus/core/instructions/README.md` | Instruction index and critical rules |
| `node_modules/@plumbus/core/instructions/guardrails.md` | Mandatory framework boundaries and git safety |
| `node_modules/@plumbus/core/instructions/framework.md` | Core framework patterns |
| `node_modules/@plumbus/core/instructions/cli.md` | CLI command reference |
| `node_modules/@plumbus/core/instructions/mcp.md` | Core MCP surface |
| `node_modules/@plumbus/core/instructions/api.md` | Core partner API surface |
| `node_modules/@plumbus/core/instructions/capabilities.md` | Capability development |
| `node_modules/@plumbus/core/instructions/entities.md` | Entity definitions |
| `node_modules/@plumbus/core/instructions/events.md` | Event system |
| `node_modules/@plumbus/core/instructions/flows.md` | Flow orchestration |
| `node_modules/@plumbus/core/instructions/prompts.md` | Prompt content and model config |
| `node_modules/@plumbus/core/instructions/ai.md` | AI integration |
| `node_modules/@plumbus/core/instructions/translations.md` | Translation catalogs |
| `node_modules/@plumbus/core/instructions/security.md` | Security model |
| `node_modules/@plumbus/core/instructions/governance.md` | Governance rules |
| `node_modules/@plumbus/core/instructions/testing.md` | Testing utilities |
| `node_modules/@plumbus/core/instructions/patterns.md` | Code patterns |
| `node_modules/@plumbus/core/instructions/deployment.md` | Production deployment |
| `node_modules/@plumbus/core/instructions/peer-dependencies.md` | Add-on peer literals (framework devs) |
| `node_modules/@plumbus/core/instructions/upgrading-0.5-capabilities.md` | 0.5.x capability migration |
| `node_modules/@plumbus/ui/instructions/framework.md` | UI generation overview |
| `node_modules/@plumbus/ui/instructions/client-generator.md` | Client and hook generation |
| `node_modules/@plumbus/ui/instructions/auth-generator.md` | Frontend auth helpers |
| `node_modules/@plumbus/ui/instructions/form-generator.md` | Form metadata extraction |
| `node_modules/@plumbus/ui/instructions/nextjs-template.md` | Next.js scaffold generation |
| `node_modules/@plumbus/ui/instructions/testing.md` | Frontend testing guidance |
| `node_modules/@plumbus/ui/instructions/patterns.md` | UI generation patterns |
| `node_modules/@plumbus/ui/instructions/translation-generator.md` | Translation catalog generation |
| `node_modules/@plumbus/chat/instructions/README.md` | Chat instruction index (optional package) |
| `node_modules/@plumbus/chat/instructions/framework.md` | Chat package boundary and critical rules |
| `node_modules/@plumbus/chat/instructions/defining-chats.md` | `defineChat` recipe and config shape |
| `node_modules/@plumbus/chat/instructions/policies.md` | Chat policy guards |
| `node_modules/@plumbus/chat/instructions/context-sources.md` | Context sources (knowledgeContext, ragContext, etc.) |
| `node_modules/@plumbus/chat/instructions/testing.md` | Chat testing helpers |
| `node_modules/@plumbus/chat/instructions/extending.md` | Extending chat runtime |
| `node_modules/@plumbus/chat-ui/instructions/README.md` | chat-ui instruction index (optional package) |
| `node_modules/@plumbus/chat-ui/instructions/framework.md` | chat-ui package boundary, public exports, critical rules |
| `node_modules/@plumbus/chat-ui/instructions/wiring-chat-panel.md` | `<ChatPanel />` recipe, persistence pairing, `turnUrl` |
| `node_modules/@plumbus/chat-ui/instructions/custom-ui.md` | Headless `useChat`, pure helpers, `readChatStream` |
| `node_modules/@plumbus/chat-ui/instructions/action-confirmation.md` | Wiring `chatConfirmAction` directly (the v0.1 `confirm()` stub) |
| `node_modules/@plumbus/knowledge-base/instructions/README.md` | Knowledge-base instruction index (optional package) |
| `node_modules/@plumbus/knowledge-base/instructions/conventions.md` | KB conventions, file map, critical rules |
| `node_modules/@plumbus/knowledge-base/instructions/defining-sources.md` | `defineKnowledgeSource` + registry recipe |
| `node_modules/@plumbus/knowledge-base/instructions/providers.md` | Built-in provider picker |
| `node_modules/@plumbus/knowledge-base/instructions/chat-integration.md` | `knowledgeContext` wiring |
| `node_modules/@plumbus/knowledge-base/instructions/testing.md` | KB test helpers |
| `node_modules/@plumbus/mcp/instructions/README.md` | MCP instruction index (optional package) |
| `node_modules/@plumbus/mcp/instructions/framework.md` | MCP package boundary, public exports, critical rules |
| `node_modules/@plumbus/mcp/instructions/expose-a-capability.md` | `exposeAs: ['mcp']` recipe + agent token config |
| `node_modules/@plumbus/mcp/instructions/tasks.md` | `kind: 'job'` over MCP Tasks (`mcpTaskEntity`, progress, cancel) |
| `node_modules/@plumbus/mcp/instructions/testing.md` | `@plumbus/mcp/testing` helpers |
| `node_modules/@plumbus/api/instructions/README.md` | Partner API instruction index (optional package) |
| `node_modules/@plumbus/api/instructions/framework.md` | API package boundary, public exports, critical rules |
| `node_modules/@plumbus/api/instructions/expose-a-capability.md` | `exposeAs: ['api']` recipe + `registerApiRoutes` wiring |
| `node_modules/@plumbus/api/instructions/manifest-and-cli.md` | `api.yaml`, validation, OpenAPI/docs, `plumbus api` CLI |
| `node_modules/@plumbus/api/instructions/testing.md` | Test intent, idempotency, fixture validation |
| `node_modules/@plumbus/auth/instructions/README.md` | Auth instruction index (optional package) |
| `node_modules/@plumbus/auth/instructions/framework.md` | Auth package boundary, public exports, critical rules |
| `node_modules/@plumbus/auth/instructions/configure-runtime.md` | `createAuthRuntime` + `createServer({ authenticationRuntime })` recipe |
| `node_modules/@plumbus/auth/instructions/providers.md` | OIDC provider registration and integrations |
| `node_modules/@plumbus/auth/instructions/sessions-and-csrf.md` | `/auth/session` contract and CSRF headers |
| `node_modules/@plumbus/auth/instructions/resolvers.md` | `resolveIdentity` and `resolveAuthorization` hooks |
| `node_modules/@plumbus/auth/instructions/testing.md` | Fake OIDC provider integration tests |
| `node_modules/@plumbus/auth-cognito/instructions/README.md` | Cognito instruction index (optional package) |
| `node_modules/@plumbus/auth-cognito/instructions/configure-cognito.md` | `cognito()` integration registration |
| `node_modules/@plumbus/auth-cognito/instructions/hosted-login-options.md` | Hosted UI IdP allowlist |
| `node_modules/@plumbus/auth-cognito/instructions/logout.md` | Cognito logout URL builder |
| `node_modules/@plumbus/voice/instructions/framework.md` | Voice runtime overview and critical rules (optional package) |
| `node_modules/@plumbus/voice/instructions/defining-voices.md` | `defineVoice` and route registration |
| `node_modules/@plumbus/voice/instructions/providers.md` | STT, TTS, and transport providers |
| `node_modules/@plumbus/voice/instructions/testing.md` | Voice testing helpers |
| `node_modules/@plumbus/browser-extension/instructions/browser-extension.md` | Browser extension scaffold recipe (optional package) |

## Verifying Agent Setup

```bash
plumbus doctor
```

The doctor command checks whether agent wiring files exist and are properly configured.

It also warns when generated Copilot, Cursor, or `AGENTS.md` wiring files predate the current Plumbus template version. Doctor now recommends the safest follow-up command for each case: `plumbus init` for missing wiring, `plumbus init --patch` for patchable generated wiring, and `plumbus init --force` for files that cannot be safely patched.

## Troubleshooting

### Agent doesn't recognize Plumbus patterns

1. Run `plumbus init --patch --agent <your-agent>` to refresh the managed wiring sections
2. Restart your editor to reload agent context
3. Check that `@plumbus/core` is installed with `plumbus doctor`

### Agent generates incorrect code

1. Check the instruction files are up to date: `plumbus init --patch`
2. Verify the agent is loading the instructions (check agent logs/settings)
3. Generate project briefs for richer context: `plumbus agent sync`

If the agent still tries to implement around Plumbus primitives, confirm that the generated wiring contains the guardrails section and that the project has been reinitialized after the last framework upgrade.

### Instructions are stale after upgrade

```bash
npm update @plumbus/core
plumbus init --patch --agent <your-agent>
```

This refreshes the Plumbus-managed wiring sections with the latest instructions while preserving surrounding custom notes. If doctor reports that a file cannot be patched safely, rerun with `--force` for that full replacement.

