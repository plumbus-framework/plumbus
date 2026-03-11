# AI Runtime

Plumbus provides structured AI interactions through prompts and the `ctx.ai` service.

## Defining a Prompt

```ts
import { definePrompt } from "plumbus-core";
import { z } from "zod";

export const summarizeTicket = definePrompt({
  name: "summarizeTicket",
  domain: "support",

  input: z.object({ ticketText: z.string(), customerTier: z.string() }),
  output: z.object({
    summary: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    sentiment: z.enum(["positive", "neutral", "negative"]),
  }),

  model: {
    provider: "openai",
    name: "gpt-4",
    temperature: 0.3,
    maxTokens: 500,
  },
});
```

## `ctx.ai` Operations

### Generate

Invoke a named prompt with typed input, get validated output:

```ts
const result = await ctx.ai.generate({
  prompt: "summarizeTicket",
  input: { ticketText: input.text, customerTier: "enterprise" },
});
// result is typed: { summary: string, priority: "low"|"medium"|"high", sentiment: ... }
```

### Extract

Extract structured data from text using a Zod schema:

```ts
const invoice = await ctx.ai.extract({
  schema: z.object({ invoiceNumber: z.string(), total: z.number(), dueDate: z.string() }),
  text: input.emailBody,
});
```

### Classify

Classify text into provided categories:

```ts
const labels = await ctx.ai.classify({
  labels: ["billing", "technical", "general", "urgent"],
  text: input.ticketText,
});
```

### Retrieve (RAG)

Retrieve relevant documents from the vector store:

```ts
const docs = await ctx.ai.retrieve({ query: "refund policy for enterprise customers" });
// docs: Array<{ content: string, source: string, score: number, metadata?: Record<string, unknown> }>
```

## Output Validation

All AI responses are validated against the prompt's output Zod schema. On failure, the framework retries generation (configurable). If retries are exhausted, a structured error is raised.

## Cost Tracking

Every AI invocation records: model used, input/output token counts, estimated cost, latency, and prompt name. Budget limits (per-request, daily, per-tenant) can be enforced via configuration.

## Security

- Classified fields in prompt inputs are detected and warn/redact based on entity field classifications
- Tenant isolation is enforced — prompts cannot access cross-tenant data
- All AI invocations are recorded in the audit trail
