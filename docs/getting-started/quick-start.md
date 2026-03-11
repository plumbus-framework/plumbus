# Quick Start

Build your first Plumbus capability in 5 minutes.

## 1. Create the Project

```bash
plumbus create hello-plumbus
cd hello-plumbus
```

## 2. Define an Entity

```typescript
// app/entities/greeting.entity.ts
import { defineEntity, field } from "plumbus-core";

export const Greeting = defineEntity({
  name: "Greeting",
  description: "A stored greeting message",
  fields: {
    id: field.id(),
    message: field.string(),
    author: field.string({ classification: "personal" }),
    createdAt: field.timestamp({ defaultNow: true }),
  },
});
```

## 3. Define a Capability

```typescript
// app/capabilities/greetings/create-greeting/capability.ts
import { defineCapability } from "plumbus-core";
import { z } from "zod";

export const createGreeting = defineCapability({
  name: "createGreeting",
  kind: "action",
  domain: "greetings",
  description: "Create a new greeting",
  input: z.object({
    message: z.string().min(1).max(500),
    author: z.string().min(1),
  }),
  output: z.object({
    id: z.string(),
    message: z.string(),
  }),
  access: { roles: ["user", "admin"] },
  effects: { writes: ["Greeting"], emits: ["greeting.created"] },
  handler: async (ctx, input) => {
    const greeting = await ctx.data.Greeting.create(input);
    await ctx.events.emit("greeting.created", {
      greetingId: greeting.id,
      author: input.author,
    });
    return { id: greeting.id, message: greeting.message };
  },
});
```

## 4. Define a Query

```typescript
// app/capabilities/greetings/list-greetings/capability.ts
import { defineCapability } from "plumbus-core";
import { z } from "zod";

export const listGreetings = defineCapability({
  name: "listGreetings",
  kind: "query",
  domain: "greetings",
  description: "List all greetings",
  input: z.object({}),
  output: z.array(z.object({
    id: z.string(),
    message: z.string(),
    author: z.string(),
  })),
  access: { public: true },
  effects: { reads: ["Greeting"] },
  handler: async (ctx) => {
    return ctx.data.Greeting.findMany();
  },
});
```

## 5. Define an Event

```typescript
// app/events/greeting-created.event.ts
import { defineEvent } from "plumbus-core";
import { z } from "zod";

export const greetingCreated = defineEvent({
  name: "greeting.created",
  schema: z.object({
    greetingId: z.string(),
    author: z.string(),
  }),
  description: "A new greeting was created",
});
```

## 6. Run the Development Server

```bash
plumbus dev
```

This starts a Fastify server with auto-generated routes:

```
POST /api/greetings/create-greeting  → createGreeting
GET  /api/greetings/list-greetings   → listGreetings
```

## 7. Test It

```typescript
// app/capabilities/greetings/create-greeting/tests/create-greeting.test.ts
import { runCapability } from "plumbus-core/testing";
import { expect, test } from "vitest";

test("creates a greeting", async () => {
  const result = await runCapability("createGreeting", {
    input: { message: "Hello, world!", author: "Alice" },
    auth: { userId: "usr_1", roles: ["user"], scopes: [], provider: "test" },
    data: { Greeting: [] },
  });

  expect(result.message).toBe("Hello, world!");
  expect(result.id).toBeDefined();
});
```

```bash
pnpm test
```

## What Just Happened?

```
                    ┌─────────────┐
                    │  HTTP POST  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Access    │  ← Deny-by-default security
                    │  Evaluation │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Input     │  ← Zod schema validation
                    │ Validation  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Capability │  ← Your handler runs here
                    │   Handler   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──┐  ┌─────▼─────┐  ┌──▼───────┐
       │  Data   │  │   Event   │  │  Audit   │
       │  Write  │  │  Emission │  │  Record  │
       └─────────┘  └───────────┘  └──────────┘
```

The framework automatically:
1. Matched the HTTP route to your capability
2. Evaluated the access policy against the caller's auth context
3. Validated input through the Zod schema
4. Ran your handler with a fully scoped `ctx`
5. Emitted the event via the outbox pattern
6. Created an audit record
7. Validated and returned the output

## Next Steps

- [Tutorial →](tutorial.md) — Build a complete feature with flows and events
- [Capabilities →](../core-concepts/capabilities.md) — Deep dive into capability design
- [Entities →](../core-concepts/entities.md) — Data modeling guide

