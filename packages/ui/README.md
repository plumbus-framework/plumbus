# @plumbus/ui

**UI code generation for the Plumbus framework.**

Generates typed API clients, React hooks, auth helpers, form metadata, and full Next.js project scaffolds — all derived from your Plumbus capability and entity contracts.

## Install

```bash
pnpm add @plumbus/ui
```

> **Note:** `@plumbus/core` is a peer dependency and must be installed in your project.

## What It Generates

### Typed API Clients

Generate fetch-based clients with full type safety from your capability contracts:

```typescript
import { generateClientCode } from "@plumbus/ui";

const code = generateClientCode([getUserContract, createOrderContract]);
// → typed fetch functions + React hooks for each capability
```

### Auth Helpers

Generate authentication types, token utilities, and route guards:

```typescript
import { generateAuthCode } from "@plumbus/ui";

const code = generateAuthCode(authConfig);
// → AuthUser type, useAuth hook, token helpers, withAuth guard
```

### Form Metadata

Extract form field metadata from Zod schemas in your entity definitions:

```typescript
import { generateFormMetadata } from "@plumbus/ui";

const fields = generateFormMetadata(userEntity);
// → field types, labels, validation rules, select options
```

### Next.js Scaffolding

Generate a complete Next.js project from your contracts:

```typescript
import { generateNextjsTemplate } from "@plumbus/ui";

const files = generateNextjsTemplate({
  capabilities: [getUser, createOrder],
  entities: [User, Order],
  auth: { provider: "jwt" },
});
// → Full Next.js app with pages, layouts, API routes, and auth
```

## AI Agent Instructions

This package ships instruction files for AI coding agents:

```
node_modules/@plumbus/ui/instructions/
├── framework.md         # UI package overview and concepts
├── client-generator.md  # Typed fetch clients and React hooks
├── auth-generator.md    # Auth types, token utils, route guards
├── form-generator.md    # Zod schema → form field extraction
├── nextjs-template.md   # Full Next.js project scaffold
├── patterns.md          # UI conventions and best practices
└── testing.md           # UI test setup and patterns
```

## Documentation

Full documentation: [github.com/plumbus-framework/plumbus/docs](https://github.com/plumbus-framework/plumbus/tree/main/docs)

## The Plumbus ecosystem

| Package | Purpose | When to install |
|---|---|---|
| [`@plumbus/core`](../plumbus-core/) | Foundation — capabilities, entities, events, flows, prompts, translations, runtime, CLI, audit, governance. | Always (required). |
| **`@plumbus/ui`** | **You are here.** Next.js/React UI — typed API clients, auth helpers, form metadata, scaffolds. | When building a Plumbus web UI. |
| [`@plumbus/api`](../api/) | Partner external API — manifest, OpenAPI, docs, compatibility diff, test intent. | Optional peer `0.1.x` — when publishing a documented partner-facing HTTP API. |
| [`@plumbus/mcp`](../mcp/) | MCP runtime — serve capabilities to AI agents (`tools/*`, `tasks/*`, transports). | Optional peer `0.4.x` — when exposing capabilities to MCP clients. |
| [`@plumbus/chat`](../chat/) | Conversational runtime — `defineChat`, policy guards, context sources, streamed events. | Optional peer `0.1.x` — when adding a chat surface. |
| [`@plumbus/chat-ui`](../chat-ui/) | React chat UI — hooks and `<ChatPanel />` for the `@plumbus/chat` turn protocol. | Peer of `@plumbus/chat` — when adding a browser chat client. |
| [`@plumbus/knowledge-base`](../knowledge-base/) | Knowledge providers — scoped sources, registry, chat `knowledgeContext` integration. | Optional peer of `@plumbus/chat` `0.1.x` — when sharing named knowledge across features. |
| [`@plumbus/browser-extension`](../browser-extension/) | Extension scaffolder — WXT Chrome/Firefox project wired to your capabilities. | With `@plumbus/ui` (`0.1.x`) — when shipping a browser extension UI. |

## License

MIT
