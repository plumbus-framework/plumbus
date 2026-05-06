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
│ node_modules/@plumbus/core/instructions/                     │
│ node_modules/@plumbus/ui/instructions/                      │
│                                                             │
│  guardrails.md    ← Mandatory architecture + git safety     │
│  framework.md     ← Core patterns and conventions           │
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

Creates `.cursor/rules/plumbus.mdc` — loaded by Cursor as a project rule.

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
# Generate a brief for a specific resource
plumbus agent brief capability getUser
plumbus agent brief entity User
plumbus agent brief flow orderFulfillment

# Sync all briefs
plumbus agent sync
```

Briefs are stored in `.plumbus/briefs/` and provide rich context about each resource to AI agents.

## Inline Mode

For smaller projects or agents that work better with inline instructions:

```bash
plumbus init --agent copilot --inline
```

This embeds the full instruction content directly into the wiring file instead of referencing `node_modules/` paths.

## Instruction File Locations

| Path | Content |
|------|---------|
| `node_modules/@plumbus/core/instructions/guardrails.md` | Mandatory framework boundaries and git safety |
| `node_modules/@plumbus/core/instructions/framework.md` | Core framework patterns |
| `node_modules/@plumbus/core/instructions/capabilities.md` | Capability development |
| `node_modules/@plumbus/core/instructions/entities.md` | Entity definitions |
| `node_modules/@plumbus/core/instructions/events.md` | Event system |
| `node_modules/@plumbus/core/instructions/flows.md` | Flow orchestration |
| `node_modules/@plumbus/core/instructions/ai.md` | AI integration |
| `node_modules/@plumbus/core/instructions/security.md` | Security model |
| `node_modules/@plumbus/core/instructions/governance.md` | Governance rules |
| `node_modules/@plumbus/core/instructions/testing.md` | Testing utilities |
| `node_modules/@plumbus/core/instructions/patterns.md` | Code patterns |
| `node_modules/@plumbus/ui/instructions/framework.md` | UI generation overview |
| `node_modules/@plumbus/ui/instructions/client-generator.md` | Client and hook generation |
| `node_modules/@plumbus/ui/instructions/auth-generator.md` | Frontend auth helpers |
| `node_modules/@plumbus/ui/instructions/form-generator.md` | Form metadata extraction |
| `node_modules/@plumbus/ui/instructions/nextjs-template.md` | Next.js scaffold generation |
| `node_modules/@plumbus/ui/instructions/testing.md` | Frontend testing guidance |
| `node_modules/@plumbus/ui/instructions/patterns.md` | UI generation patterns |

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

