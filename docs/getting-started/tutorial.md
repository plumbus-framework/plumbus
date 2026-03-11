# Tutorial: Building a Support Ticket System

This tutorial walks through building a complete feature — a support ticket system with AI classification, workflow automation, and event-driven side effects.

## What We'll Build

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  createTicket │────▶│ ticket.created│────▶│classifyTicket│
│  (action)    │     │ (event)      │     │ (eventHandler)│
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                           ┌──────▼───────┐
                                           │  ticketTriage │
                                           │  (flow)      │
                                           └──────┬───────┘
                                                  │
                              ┌────────────────────┼──────────────────┐
                              │                    │                  │
                       ┌──────▼──────┐     ┌──────▼──────┐   ┌──────▼──────┐
                       │  escalate   │     │  assign     │   │  autoReply  │
                       │  (action)   │     │  (action)   │   │  (action)   │
                       └─────────────┘     └─────────────┘   └─────────────┘
```

## Step 1: Define the Entity

```typescript
// app/entities/ticket.entity.ts
import { defineEntity, field } from "plumbus-core";

export const Ticket = defineEntity({
  name: "Ticket",
  description: "Customer support ticket",
  tenantScoped: true,
  fields: {
    id: field.id(),
    subject: field.string(),
    body: field.string(),
    customerEmail: field.string({ classification: "personal", maskedInLogs: true }),
    category: field.enum({ values: ["billing", "technical", "general"] }),
    priority: field.enum({ values: ["low", "medium", "high", "critical"] }),
    status: field.enum({ values: ["open", "in_progress", "resolved", "closed"] }),
    assigneeId: field.string({ optional: true }),
    createdAt: field.timestamp({ defaultNow: true }),
    updatedAt: field.timestamp({ defaultNow: true }),
  },
});
```

## Step 2: Define Events

```typescript
// app/events/ticket-created.event.ts
import { defineEvent } from "plumbus-core";
import { z } from "zod";

export const ticketCreated = defineEvent({
  name: "ticket.created",
  schema: z.object({
    ticketId: z.string(),
    subject: z.string(),
    category: z.string().optional(),
  }),
  description: "A new support ticket was submitted",
});
```

## Step 3: Define the AI Prompt

```typescript
// app/prompts/classify-ticket.prompt.ts
import { definePrompt } from "plumbus-core";
import { z } from "zod";

export const classifyTicket = definePrompt({
  name: "classifyTicket",
  model: "gpt-4o-mini",
  input: z.object({ subject: z.string(), body: z.string() }),
  output: z.object({
    category: z.enum(["billing", "technical", "general"]),
    priority: z.enum(["low", "medium", "high", "critical"]),
    sentiment: z.enum(["positive", "neutral", "negative"]),
    suggestedResponse: z.string(),
  }),
  systemPrompt: `You are a support ticket classifier. Analyze the ticket and return:
- category: billing, technical, or general
- priority: low, medium, high, or critical
- sentiment: positive, neutral, or negative
- suggestedResponse: a brief suggested reply`,
});
```

## Step 4: Create the Ticket Capability

```typescript
// app/capabilities/support/create-ticket/capability.ts
import { defineCapability } from "plumbus-core";
import { z } from "zod";

export const createTicket = defineCapability({
  name: "createTicket",
  kind: "action",
  domain: "support",
  description: "Submit a new support ticket",
  input: z.object({
    subject: z.string().min(5).max(200),
    body: z.string().min(10).max(5000),
    customerEmail: z.string().email(),
  }),
  output: z.object({
    ticketId: z.string(),
    status: z.string(),
  }),
  access: { public: true },
  effects: {
    writes: ["Ticket"],
    emits: ["ticket.created"],
  },
  handler: async (ctx, input) => {
    const ticket = await ctx.data.Ticket.create({
      ...input,
      status: "open",
      category: "general", // Will be updated by AI classification
      priority: "medium",
    });

    await ctx.events.emit("ticket.created", {
      ticketId: ticket.id,
      subject: input.subject,
    });

    return { ticketId: ticket.id, status: "open" };
  },
});
```

## Step 5: AI Classification Event Handler

```typescript
// app/capabilities/support/classify-ticket/capability.ts
import { defineCapability } from "plumbus-core";
import { z } from "zod";

export const classifyTicketHandler = defineCapability({
  name: "classifyTicketHandler",
  kind: "eventHandler",
  domain: "support",
  description: "Auto-classify a new ticket using AI",
  input: z.object({ ticketId: z.string(), subject: z.string() }),
  output: z.object({ category: z.string(), priority: z.string() }),
  access: { serviceAccounts: ["event-worker"] },
  effects: {
    reads: ["Ticket"],
    writes: ["Ticket"],
    ai: ["classifyTicket"],
  },
  handler: async (ctx, input) => {
    const ticket = await ctx.data.Ticket.findById(input.ticketId);
    if (!ticket) throw ctx.errors.notFound("Ticket not found");

    // AI classification
    const classification = await ctx.ai.generate({
      prompt: "classifyTicket",
      input: { subject: ticket.subject, body: ticket.body },
    });

    // Update ticket with AI results
    await ctx.data.Ticket.update(ticket.id, {
      category: classification.category,
      priority: classification.priority,
    });

    ctx.logger.info("Ticket classified", {
      ticketId: ticket.id,
      category: classification.category,
      priority: classification.priority,
    });

    return { category: classification.category, priority: classification.priority };
  },
});
```

## Step 6: Define the Triage Flow

```typescript
// app/flows/support/ticket-triage/flow.ts
import { defineFlow } from "plumbus-core";

export const ticketTriage = defineFlow({
  name: "ticketTriage",
  domain: "support",
  description: "Triage and route a classified ticket",
  trigger: { type: "event", event: "ticket.classified" },
  steps: [
    { name: "checkPriority", capability: "getTicketPriority" },
    {
      name: "route",
      type: "conditional",
      condition: "ctx.state.priority === 'critical'",
      ifTrue: "escalate",
      ifFalse: "normalAssign",
    },
    { name: "escalate", capability: "escalateTicket" },
    { name: "normalAssign", capability: "assignTicket" },
    { name: "autoReply", capability: "sendAutoReply" },
  ],
  retry: { maxAttempts: 3, backoff: "exponential" },
});
```

## Step 7: Write Tests

```typescript
// app/capabilities/support/create-ticket/tests/create-ticket.test.ts
import { runCapability, createTestContext, mockAI } from "plumbus-core/testing";
import { expect, describe, it } from "vitest";

describe("createTicket", () => {
  it("creates a ticket and emits event", async () => {
    const result = await runCapability("createTicket", {
      input: {
        subject: "Cannot login to my account",
        body: "I keep getting an error when trying to login...",
        customerEmail: "alice@example.com",
      },
      data: { Ticket: [] },
    });

    expect(result.ticketId).toBeDefined();
    expect(result.status).toBe("open");
  });

  it("validates input", async () => {
    await expect(
      runCapability("createTicket", {
        input: { subject: "Hi", body: "Too short", customerEmail: "invalid" },
        data: { Ticket: [] },
      }),
    ).rejects.toThrow();
  });
});

describe("classifyTicketHandler", () => {
  it("classifies using AI", async () => {
    const result = await runCapability("classifyTicketHandler", {
      input: { ticketId: "t_1", subject: "Billing error" },
      auth: { userId: "svc_1", roles: [], scopes: [], provider: "service" },
      data: {
        Ticket: [{ id: "t_1", subject: "Billing error", body: "I was overcharged..." }],
      },
      ai: mockAI({
        classifyTicket: {
          category: "billing",
          priority: "high",
          sentiment: "negative",
          suggestedResponse: "We apologize for the billing issue.",
        },
      }),
    });

    expect(result.category).toBe("billing");
    expect(result.priority).toBe("high");
  });
});
```

## Step 8: Run and Verify

```bash
# Run tests
pnpm test

# Check governance rules
plumbus verify

# Start dev server
plumbus dev

# Test the API
curl -X POST http://localhost:3000/api/support/create-ticket \
  -H "Content-Type: application/json" \
  -d '{"subject": "Cannot login", "body": "I keep getting errors...", "customerEmail": "alice@test.com"}'
```

## Recap

In this tutorial you:

1. **Defined an Entity** with typed fields and privacy classification
2. **Defined Events** for domain communication
3. **Created an AI Prompt** with structured input/output
4. **Built Capabilities** for creating and classifying tickets
5. **Composed a Flow** for automated triage routing
6. **Wrote Tests** using framework test utilities
7. **Ran Governance** checks to validate your design

The framework handled:
- HTTP route generation
- Input validation
- Access control
- AI interaction management
- Event emission via outbox pattern
- Audit trail creation
- Structured logging

