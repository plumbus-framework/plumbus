# AI Integration Guide

Plumbus provides a structured AI runtime with typed prompts, output validation, cost tracking, RAG, and security controls.

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                    AI Runtime                            │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Prompts  │  │ Providers    │  │ RAG Pipeline     │  │
│  │          │  │              │  │                  │  │
│  │ define   │  │ OpenAI       │  │ Ingest → Chunk   │  │
│  │ Prompt() │  │ Anthropic    │  │ → Embed → Store  │  │
│  │          │  │ Custom       │  │ → Retrieve       │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘  │
│       │               │                   │             │
│  ┌────▼───────────────▼───────────────────▼──────────┐  │
│  │              ctx.ai Service                       │  │
│  │  generate() | extract() | classify() | retrieve() │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─────────────┐  ┌────────────┐  ┌─────────────────┐  │
│  │ Security    │  │ Cost       │  │ Explainability  │  │
│  │ PII check   │  │ Budget     │  │ Audit trail     │  │
│  │ Scope check │  │ Tracking   │  │ Decision record │  │
│  └─────────────┘  └────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Defining Prompts

```typescript
import { definePrompt } from "plumbus-core";
import { z } from "zod";

export const classifyTicket = definePrompt({
  name: "classifyTicket",
  description: "Classify a support ticket by department and urgency",
  domain: "support",
  input: z.object({
    ticketText: z.string(),
    customerTier: z.enum(["free", "pro", "enterprise"]).optional(),
  }),
  output: z.object({
    department: z.enum(["billing", "technical", "general", "security"]),
    urgency: z.enum(["low", "medium", "high", "critical"]),
    confidence: z.number().min(0).max(1),
  }),
  model: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 256,
  },
});
```

## Using AI in Capabilities

### Generate (Structured Output)

```typescript
defineCapability({
  name: "analyzeTicket",
  kind: "action",
  domain: "support",
  effects: { data: ["Ticket"], events: ["ticket.classified"], external: [], ai: true },
  handler: async (ctx, input) => {
    const result = await ctx.ai.generate({
      prompt: "classifyTicket",
      input: { ticketText: input.body, customerTier: input.tier },
    });
    // result is { department, urgency, confidence }

    await ctx.data.Ticket.update(input.ticketId, {
      department: result.department,
      urgency: result.urgency,
    });

    return result;
  },
});
```

### Extract (Data Extraction)

```typescript
const orderDetails = await ctx.ai.extract({
  text: "Please ship 5 blue widgets to 123 Main St, NYC 10001",
  schema: z.object({
    quantity: z.number(),
    product: z.string(),
    address: z.string(),
    zipCode: z.string(),
  }),
});
```

### Classify (Categorization)

```typescript
const labels = await ctx.ai.classify({
  text: "My subscription was charged twice this month",
  labels: ["billing", "technical", "account", "general"],
});
// → ["billing"]
```

### Retrieve (RAG)

```typescript
const docs = await ctx.ai.retrieve({
  query: "How to reset password?",
});
// → [{ content: "...", source: "docs/auth.md", score: 0.94, metadata: {...} }]
```

## AI Providers

### OpenAI

```typescript
import { createOpenAIAdapter } from "plumbus-core";

const openai = createOpenAIAdapter({
  apiKey: process.env["OPENAI_API_KEY"]!,
  defaultModel: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",  // optional
});
```

### Anthropic

```typescript
import { createAnthropicAdapter } from "plumbus-core";

const anthropic = createAnthropicAdapter({
  apiKey: process.env["ANTHROPIC_API_KEY"]!,
  defaultModel: "claude-sonnet-4-20250514",
});
```

## Output Validation

AI outputs are validated against the prompt's Zod output schema. On failure, the framework retries with an enriched prompt:

```typescript
import { generateWithValidation } from "plumbus-core";

const result = await generateWithValidation({
  provider: openaiAdapter,
  prompt: classifyTicket,
  input: { ticketText: "My card was charged twice" },
  maxRetries: 2,
});
```

```
Provider response
       │
       ▼
Parse as JSON
       │
       ▼
Zod validation
       │
  ┌────┼──────┐
  │           │
Valid       Invalid
  │           │
  ▼           ▼
Return     Retry with error context
            (up to maxRetries)
```

## Cost Tracking

Every AI call is metered:

```typescript
import { createCostTracker, estimateCost } from "plumbus-core";

const tracker = createCostTracker({
  dailyBudget: 50.00,
  currency: "USD",
});

// Pre-check budget
const check = tracker.checkBudget(estimateCost("gpt-4o-mini", 1000, 500));
if (!check.allowed) {
  console.error(check.reason);
}
```

Cost records include:
- Prompt name
- Model used
- Input/output token counts
- Dollar cost
- Timestamp
- Caller identity

## RAG Pipeline

### Ingestion

```bash
# CLI
plumbus rag ingest ./docs --source knowledge-base --classification internal
```

```typescript
// Programmatic
import { createRAGPipeline, createInMemoryVectorStore } from "plumbus-core";

const vectorStore = createInMemoryVectorStore();
const rag = createRAGPipeline({
  vectorStore,
  embeddingProvider: openaiAdapter,
  chunkConfig: { maxTokens: 512, overlap: 50 },
});

await rag.ingest({
  content: "Document text...",
  source: "docs/guide.md",
  metadata: { category: "help" },
});
```

### Chunking

Documents are split into overlapping chunks:

```
┌─────────────────────────────────────────┐
│            Source Document               │
│                                         │
│  Chunk 1 (512 tokens)                   │
│  ████████████████████                   │
│                 ████ ← overlap (50 tok) │
│                 ████████████████████    │
│                 Chunk 2 (512 tokens)    │
│                              ████       │
│                              ██████████ │
│                              Chunk 3    │
└─────────────────────────────────────────┘
```

### Retrieval

```typescript
const results = await ctx.ai.retrieve({
  query: "How to configure authentication?",
});

for (const doc of results) {
  console.log(doc.content);      // Chunk text
  console.log(doc.source);       // Origin file
  console.log(doc.score);        // Relevance score (0-1)
  console.log(doc.metadata);     // Custom metadata
}
```

## Explainability

AI decisions are tracked for auditability:

```typescript
import { createExplainabilityTracker } from "plumbus-core";

const tracker = createExplainabilityTracker({
  enabled: true,
  retentionDays: 90,
});
```

Each AI invocation records:
- What prompt was used
- What input was provided (with PII redaction)
- What output was produced
- Token usage and cost
- Which capability triggered it
- Timestamp and caller identity

## Security Controls

| Control | Description |
|---------|-------------|
| PII Detection | Scans input recursively for personal data patterns, including nested objects |
| Classification Gate | Blocks `highly_sensitive` data from AI (recursive scanning) |
| Scope Verification | Caller needs appropriate AI scopes |
| Model Restriction | Prompts specify allowed models |
| Budget Enforcement | Daily cost limits prevent runaway spending |

## Testing AI

```typescript
import { mockAI, createTestContext } from "plumbus-core/testing";

const ctx = createTestContext({
  ai: mockAI({
    "classifyTicket": { department: "billing", urgency: "high", confidence: 0.95 },
  }),
});

// AI calls return mocked responses
const result = await ctx.ai.generate({
  prompt: "classifyTicket",
  input: { ticketText: "..." },
});
// → { department: "billing", urgency: "high", confidence: 0.95 }
```

