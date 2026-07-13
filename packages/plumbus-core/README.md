# @plumbus/core

**AI-native, contract-driven TypeScript application framework.**

Define your application through six composable primitives — Capabilities, Entities, Events, Flows, Prompts, and Translations — and get deny-by-default security, advisory governance, audit trails, and managed AI integration out of the box. Optional companion packages extend the surface for partner APIs, MCP agents, chat, knowledge, UI generation, and browser extensions — install only what you need.

## Install

```bash
pnpm add @plumbus/core
```

## Quick Start

```bash
# Install the CLI globally
pnpm add -g @plumbus/core

# Scaffold a new project
plumbus create my-app --auth jwt --ai openai --compliance GDPR

cd my-app
plumbus dev
```

## The Six Primitives

### Capabilities — atomic business operations

```typescript
import { defineCapability } from "@plumbus/core";
import { z } from "zod";

export const getUser = defineCapability({
  name: "getUser",
  kind: "query",
  domain: "users",
  input: z.object({ userId: z.string().uuid() }),
  output: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  access: { roles: ["admin", "user"], scopes: ["users:read"] },
  handler: async (ctx, input) => {
    const user = await ctx.data.User.findById(input.userId);
    if (!user) throw ctx.errors.notFound("User not found");
    return user;
  },
});
```

### Entities — data models with field-level classification

```typescript
import { defineEntity, field } from "@plumbus/core";

export const User = defineEntity({
  name: "User",
  tenantScoped: true,
  fields: {
    id: field.id(),
    name: field.string({ classification: "personal" }),
    email: field.string({ classification: "personal", maskedInLogs: true }),
    role: field.enum({ values: ["admin", "user", "guest"] }),
  },
});
```

### Flows — multi-step workflows

```typescript
import { defineFlow } from "@plumbus/core";

export const refundApproval = defineFlow({
  name: "refundApproval",
  domain: "billing",
  trigger: { type: "event", event: "refund.requested" },
  steps: [
    { name: "validate", capability: "validateRefund" },
    { name: "decide", type: "conditional", condition: "ctx.state.amount > 100",
      ifTrue: "managerApproval", ifFalse: "autoApprove" },
    { name: "notify", capability: "sendRefundNotification" },
  ],
});
```

### Events — domain facts

```typescript
import { defineEvent } from "@plumbus/core";
import { z } from "zod";

export const orderPlaced = defineEvent({
  name: "order.placed",
  schema: z.object({ orderId: z.string(), customerId: z.string(), total: z.number() }),
});
```

### Prompts — structured AI interactions

```typescript
import { definePrompt } from "@plumbus/core";
import { z } from "zod";

export const classifyTicket = definePrompt({
  name: "classifyTicket",
  model: "gpt-4o-mini",
  input: z.object({ ticketText: z.string() }),
  output: z.object({
    category: z.enum(["billing", "technical", "general"]),
    priority: z.enum(["low", "medium", "high"]),
  }),
  system: "Classify the support ticket and return structured JSON.",
});
```

## Subpath Exports

| Import | Purpose |
|--------|---------|
| `@plumbus/core` | SDK surface — define functions, types, runtime |
| `@plumbus/core/testing` | Test utilities — `runCapability`, `simulateFlow`, `mockAI`, `createTestContext` |
| `@plumbus/core/zod` | Re-exported Zod (consumers should not install Zod separately) |
| `@plumbus/core/vitest` | Vitest config helpers |

## CLI

```bash
plumbus create <app>          # Scaffold a new project
plumbus dev                   # Start dev server with hot reload
plumbus doctor                # Check environment readiness
plumbus generate              # Regenerate artifacts from contracts
plumbus verify                # Run governance rules
plumbus certify <profile>     # Run compliance assessment (GDPR, PCI-DSS, etc.)
plumbus migrate generate      # Generate database migration
plumbus migrate apply         # Apply pending migrations
plumbus init --agent all      # Generate AI agent wiring files
```

## AI Agent Instructions

This package ships instruction files that teach AI coding agents (Copilot, Cursor, etc.) how to use the framework:

```
node_modules/@plumbus/core/instructions/
├── README.md                      # Index — start here
├── guardrails.md                  # Mandatory framework boundaries and git safety
├── framework.md                   # Core abstractions and project structure
├── capabilities.md                # Capability definitions and handlers
├── entities.md                    # Entity fields and classifications
├── events.md                      # Event emission and outbox pattern
├── flows.md                       # Workflow steps and retry logic
├── prompts.md                     # Prompt content, system/description, model config
├── ai.md                          # ctx.ai operations, RAG, cost tracking
├── translations.md                # i18n catalogs and ctx.translations
├── security.md                    # Access policies and tenant isolation
├── governance.md                  # Advisory rules and compliance
├── testing.md                     # Test utilities and patterns
├── patterns.md                    # Naming conventions and best practices
├── cli.md                         # CLI command reference
├── mcp.md                         # Core MCP surface (exposeAs, plumbus mcp *)
├── api.md                         # Core partner API surface (exposeAs: ['api'])
├── deployment.md                  # Production deployment and workers
├── peer-dependencies.md           # Add-on peer range literals (framework devs)
└── upgrading-0.5-capabilities.md  # 0.5.x capability invocation migration
```

Wire them up with `plumbus init --agent all`.

## Documentation

Full documentation: [github.com/plumbus-framework/plumbus/docs](https://github.com/plumbus-framework/plumbus/tree/main/docs)

## The Plumbus ecosystem

| Package | Purpose | When to install |
|---|---|---|
| **`@plumbus/core`** | **You are here.** Foundation — capabilities, entities, events, flows, prompts, translations, runtime, CLI, audit, governance. | Always (required). |
| [`@plumbus/ui`](../ui/) | Next.js/React UI — typed API clients, auth helpers, form metadata, scaffolds. | When building a Plumbus web UI. |
| [`@plumbus/api`](../api/) | Partner external API — manifest, OpenAPI, docs, compatibility diff, test intent. | Optional peer `0.1.x` — when publishing a documented partner-facing HTTP API. |
| [`@plumbus/mcp`](../mcp/) | MCP runtime — serve capabilities to AI agents (`tools/*`, `tasks/*`, transports). | Optional peer `0.5.x \|\| 0.6.x` — when exposing capabilities to MCP clients. |
| [`@plumbus/chat`](../chat/) | Conversational runtime — `defineChat`, policy guards, context sources, streamed events. | Optional peer `0.1.x` — when adding a chat surface. |
| [`@plumbus/chat-ui`](../chat-ui/) | React chat UI — hooks and `<ChatPanel />` for the `@plumbus/chat` turn protocol. | Peer of `@plumbus/chat` — when adding a browser chat client. |
| [`@plumbus/knowledge-base`](../knowledge-base/) | Knowledge providers — scoped sources, registry, chat `knowledgeContext` integration. | Optional peer of `@plumbus/chat` `0.1.x` — when sharing named knowledge across features. |
| [`@plumbus/voice`](../voice/) | Real-time voice runtime — `defineVoice`, STT/TTS/transport providers, session worker, cost ledger. | Optional peer `0.3.x` on `@plumbus/core` `0.6.x` — when adding speech I/O (not speech-to-speech); complements `@plumbus/chat` text surfaces. |
| [`@plumbus/browser-extension`](../browser-extension/) | Extension scaffolder — WXT Chrome/Firefox project wired to your capabilities. | With `@plumbus/ui` (`0.1.x`) — when shipping a browser extension UI. |

## License

MIT
