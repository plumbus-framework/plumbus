# Development Workflow

This guide walks through the day-to-day workflow for building applications with Plumbus. It covers the CLI commands you'll use, the order you'll use them, and the iteration patterns that keep development productive.

## Overview

A typical Plumbus development cycle follows this loop:

```
create → define entities → migrate → define capabilities/flows/events → generate → dev → test → iterate
```

Each step maps to one or more CLI commands. Here they are in order.

---

## 1. Create a New Project

```bash
plumbus create my-app --auth jwt --ai openai --git
cd my-app
```

This scaffolds the full project structure:

```
my-app/
├── package.json
├── tsconfig.json
├── config/
│   ├── app.config.ts      # Runtime configuration (DB, auth, AI, compliance)
│   └── ai.config.ts       # AI provider settings
├── .env.example           # Environment variable template
└── app/
    ├── capabilities/      # Your capabilities go here
    ├── entities/          # Entity definitions
    ├── events/            # Event definitions
    ├── flows/             # Flow definitions
    ├── prompts/           # Prompt definitions
    └── translations/      # Translation catalogs
```

After creation, copy `.env.example` to `.env` and fill in your database URL, auth secrets, and AI API keys.

> **Note**: All CLI commands (except `create`, `doctor`, and `init`) must be run from inside a Plumbus project. The CLI validates this before executing.

---

## 2. Define Entities

Entities define your data model. Scaffold them with the CLI:

```bash
plumbus entity new User
plumbus entity new Order
```

This creates files like `app/entities/user.entity.ts`. Edit them to define your fields:

```typescript
import { defineEntity, field } from "@plumbus/core";

export const User = defineEntity({
  name: "User",
  description: "Application user",
  fields: {
    id: field.id(),
    email: field.string({ unique: true, classification: "personal" }),
    name: field.string({ classification: "personal" }),
    role: field.string({ default: "user" }),
    createdAt: field.timestamp({ defaultNow: true }),
  },
});
```

---

## 3. Set Up the Database

### Create the database

```bash
plumbus db create
```

### Generate and apply migrations

```bash
plumbus migrate generate    # Generates SQL migration from your entity definitions
plumbus migrate push        # Applies pending migrations to the database
```

Run `plumbus migrate generate` every time you change entity fields. The migration system tracks what's already been applied, so it only generates diffs.

> **Important:** Plumbus manages 9 internal framework tables (audit, event system, flows, RAG). Do not create these tables manually — they are included in generated migrations. If you see a "schema drift" error, it means a framework table already exists in the database. Drop the conflicting table(s) and re-run the migration command.

### Seed data (optional)

Create seed files in `app/seeds/` and run:

```bash
plumbus seed
```

---

## 4. Define Capabilities

Capabilities are the core units of work in Plumbus — every API endpoint, query, or action is a capability.

```bash
plumbus capability new CreateUser --domain users
plumbus capability new GetUser --domain users
```

This creates a structured directory with the capability definition and a test file:

```
app/capabilities/users/create-user/
├── capability.ts
└── tests/
    └── create-user.test.ts
```

Edit the capability to define input/output schemas, access rules, and the handler:

```typescript
import { defineCapability } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const createUser = defineCapability({
  name: "createUser",
  kind: "action",
  domain: "users",
  description: "Create a new user",
  input: z.object({
    email: z.string().email(),
    name: z.string(),
  }),
  output: z.object({ id: z.string() }),
  access: { roles: ["admin"] },
  effects: { data: ["User"], events: ["user.created"], external: [], ai: false },
  handler: async (ctx, input) => {
    const user = await ctx.data.User.create(input);
    await ctx.events.emit("user.created", { userId: user.id });
    return { id: user.id };
  },
});
```

---

## 5. Define Events (optional)

Events model things that happened in your system:

```bash
plumbus event new UserCreated
```

```typescript
import { defineEvent } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const userCreated = defineEvent({
  name: "user.created",
  schema: z.object({ userId: z.string() }),
  description: "A new user was created",
});
```

---

## 6. Define Flows (optional)

Flows orchestrate multi-step processes:

```bash
plumbus flow new OnboardUser --domain users
```

---

## 7. Generate Code

Once your definitions are in place, generate API clients, React hooks, OpenAPI specs, and typed entity interfaces:

```bash
plumbus generate
```

Generated artifacts go to `.plumbus/generated/`:

```
.plumbus/generated/
├── capability-types.ts  # Input/Output types + CapabilityName union
├── clients/
│   ├── api.ts           # Typed API client functions
│   └── hooks.ts         # React hooks (useCreateUser, etc.)
├── entity-types.ts      # Typed entity interfaces + DataServiceMap
├── openapi.json         # OpenAPI 3.1 spec
└── manifest.json        # Resource manifest
```

- **`capability-types.ts`** — TypeScript types inferred from each capability's Zod input/output schemas (e.g. `CreateUserInput`, `CreateUserOutput`), plus a `CapabilityName` union type for type-safe capability references
- **`clients/api.ts`** / **`hooks.ts`** — import and use the types from `capability-types.ts` so generated client code is fully typed
- **`entity-types.ts`** — TypeScript interfaces for each entity (e.g. `UserRecord`) and a `DataServiceMap` that maps entity names to typed `Repository<T>` instances, giving you full type safety on `ctx.data`

Re-run `plumbus generate` any time you add or change capabilities or entities.

---

## 8. Start Development

```bash
plumbus dev
```

This starts a Fastify development server with:

- Auto-generated REST routes from your capabilities
- Hot reload on file changes
- Request validation against your Zod schemas
- Automatic access policy enforcement

Your capabilities are exposed as endpoints:

| Capability | Endpoint |
|-----------|----------|
| `createUser` (action) | `POST /api/users/create-user` |
| `getUser` (query) | `GET /api/users/get-user` |

---

## 9. Test

```bash
plumbus test              # Run all tests
plumbus test --watch      # Watch mode
plumbus e2e               # End-to-end browser tests
```

Tests live next to their capabilities. Use `runCapability()` from the testing utilities:

```typescript
import { runCapability } from "@plumbus/core/testing";
import { expect, test } from "vitest";
import { createUser } from "../capability.js";

test("creates a user", async () => {
  const result = await runCapability(
    createUser,
    { email: "alice@example.com", name: "Alice" },
    {
      auth: { userId: "usr_1", roles: ["admin"], scopes: [], provider: "test" },
      data: { User: [] },
    },
  );

  expect(result.success).toBe(true);
  if (result.success) expect(result.data.id).toBeDefined();
});
```

---

## 10. Governance & Compliance

Check your application against governance rules:

```bash
plumbus verify             # Advisory governance checks
plumbus certify            # Compliance profile assessment
```

Governance is advisory — it warns but never blocks.

---

## The Iteration Loop

Once your project is set up, daily development looks like this:

```
Edit entity fields → plumbus migrate generate → plumbus migrate push
         ↓
Add/edit capabilities → plumbus generate → plumbus dev → plumbus test
         ↓
Check governance → plumbus verify
```

### Key commands at a glance

| What you're doing | Command |
|-------------------|---------|
| Add a new entity | `plumbus entity new <Name>` → edit fields → `plumbus migrate generate` → `plumbus migrate push` |
| Add a new capability | `plumbus capability new <Name> --domain <domain>` → edit handler → `plumbus generate` |
| Regenerate after changes | `plumbus generate` |
| Start dev server | `plumbus dev` |
| Run tests | `plumbus test` |
| Check environment | `plumbus doctor` |
| Wire AI coding agents | `plumbus init --agent copilot` |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Cannot find package 'drizzle-kit'` | Update `@plumbus/core` — this was fixed so drizzle-kit is provided by the framework |
| CLI creates files in wrong directory | Make sure you're inside your Plumbus project (`package.json` with `@plumbus/core`) |
| `plumbus dev` shows no routes | Check that your capabilities export `defineCapability()` results and are in `app/capabilities/` |
| Migrations fail | Run `plumbus doctor` to check your database connection, then verify your `.env` has the correct `DATABASE_URL` |
| Schema drift error | A framework-managed table was created manually. Drop the conflicting table(s) listed in the error and re-run `plumbus migrate apply` or `plumbus migrate push` |
| Tests can't find vitest | Don't install vitest yourself — it's provided by `@plumbus/core`. Run tests with `plumbus test` |
