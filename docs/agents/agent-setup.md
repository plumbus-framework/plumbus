# AI Agent Integration

This guide explains how to configure AI coding agents (GitHub Copilot, Cursor, Windsurf, etc.) to understand the Plumbus framework and generate correct code.

## Quick Setup

```bash
# Initialize agent wiring (picks best format automatically)
plumbus init

# Or specify the agent
plumbus init --agent copilot
plumbus init --agent cursor
plumbus init --agent agents-md
```

That's it. Your AI agent now understands Plumbus conventions.

## How It Works

```
plumbus init
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│ Reads instruction files from:                               │
│ node_modules/plumbus-core/instructions/                     │
│                                                             │
│  framework.md     ← Core patterns and conventions           │
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
| **Capabilities** | How to use `defineCapability()`, all 4 kinds, handler patterns |
| **Entities** | How to use `defineEntity()`, field types, classification |
| **Events** | How to use `defineEvent()`, outbox pattern, consumers |
| **Flows** | How to use `defineFlow()`, step types, state machines |
| **AI** | How to use `definePrompt()`, providers, RAG, cost controls |
| **Security** | Access policies, tenant isolation, deny-by-default |
| **Governance** | Built-in rules, compliance profiles, overrides |
| **Testing** | `runCapability()`, `simulateFlow()`, `mockAI()`, security asserts |
| **Patterns** | Common implementation patterns and idioms |

## Manual Setup

If you prefer not to use the CLI, create the files manually:

### GitHub Copilot

Create `.github/copilot-instructions.md`:

```markdown
# Plumbus Framework Instructions

This project uses the Plumbus framework. Follow these conventions:

## Capabilities
- Use `defineCapability()` from `plumbus-core`
- Kinds: query (GET), action (POST), job (async), eventHandler
- Always declare `access` and `effects`
- Use `ctx.data`, `ctx.events`, `ctx.ai` in handlers

## Entities
- Use `defineEntity()` with `field.*` constructors
- Set `classification` on fields containing user data
- Use `tenantScoped: true` for multi-tenant data

## Testing
- Import from `plumbus-core/testing`
- Use `runCapability()` for unit tests
- Use `simulateFlow()` for flow tests
- Always test security with `assertAccessDenied()`

See node_modules/plumbus-core/instructions/ for full details.
```

### Cursor

Create `.cursor/rules/plumbus.mdc`:

```markdown
---
description: Plumbus Framework rules
globs: ["**/*.ts"]
---

# Plumbus Framework

Use `defineCapability()`, `defineEntity()`, `defineEvent()`, `defineFlow()`,
`definePrompt()` from `plumbus-core`.

Always declare access policies. Use `plumbus-core/testing` for tests.
See `node_modules/plumbus-core/instructions/` for complete guidelines.
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
| `node_modules/plumbus-core/instructions/framework.md` | Core framework patterns |
| `node_modules/plumbus-core/instructions/capabilities.md` | Capability development |
| `node_modules/plumbus-core/instructions/entities.md` | Entity definitions |
| `node_modules/plumbus-core/instructions/events.md` | Event system |
| `node_modules/plumbus-core/instructions/flows.md` | Flow orchestration |
| `node_modules/plumbus-core/instructions/ai.md` | AI integration |
| `node_modules/plumbus-core/instructions/security.md` | Security model |
| `node_modules/plumbus-core/instructions/governance.md` | Governance rules |
| `node_modules/plumbus-core/instructions/testing.md` | Testing utilities |
| `node_modules/plumbus-core/instructions/patterns.md` | Code patterns |

## Verifying Agent Setup

```bash
plumbus doctor
```

The doctor command checks whether agent wiring files exist and are properly configured.

## Troubleshooting

### Agent doesn't recognize Plumbus patterns

1. Run `plumbus init --agent <your-agent>` to regenerate wiring files
2. Restart your editor to reload agent context
3. Check that `plumbus-core` is installed with `plumbus doctor`

### Agent generates incorrect code

1. Check the instruction files are up to date: `plumbus init`
2. Verify the agent is loading the instructions (check agent logs/settings)
3. Generate project briefs for richer context: `plumbus agent sync`

### Instructions are stale after upgrade

```bash
npm update plumbus-core
plumbus init --agent <your-agent>
```

This regenerates wiring files with the latest instructions.

