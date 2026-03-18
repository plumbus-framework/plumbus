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

## License

MIT
