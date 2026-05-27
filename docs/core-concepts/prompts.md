# Prompts

Prompts provide **structured AI interactions** with typed input/output, output validation, cost tracking, and security controls.

## Defining a Prompt

```typescript
import { definePrompt } from "@plumbus/core";
import { z } from "zod";

export const summarizeTicket = definePrompt({
  name: "summarizeTicket",
  model: { name: "gpt-4o-mini", temperature: 0.2 },
  input: z.object({
    ticketText: z.string(),
    context: z.string().optional(),
  }),
  output: z.object({
    summary: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    sentiment: z.enum(["positive", "neutral", "negative"]),
    suggestedActions: z.array(z.string()),
  }),
  system: `You are a support ticket analyzer. Given a ticket, produce:
- summary: concise summary of the issue
- priority: urgency level
- sentiment: customer sentiment
- suggestedActions: recommended next steps

Return valid JSON matching the output schema.`,
});
```

`model` is a `ModelConfig` object — `{ provider?, name?, temperature?, maxTokens? }`. Leaving any field unset falls back to the provider's default. Set `provider: "openai" | "anthropic" | …` when you have multiple providers configured and want this prompt to pin to one.

## Using Prompts via ctx.ai

### Generate (structured output)

```typescript
handler: async (ctx, input) => {
  const result = await ctx.ai.generate({
    prompt: "summarizeTicket",
    input: { ticketText: input.body },
  });

  // result is fully typed: { summary, priority, sentiment, suggestedActions }
  return { summary: result.summary, priority: result.priority };
}
```

### Extract (data extraction)

```typescript
const entities = await ctx.ai.extract({
  text: "John Smith ordered 3 widgets at $10 each",
  schema: z.object({
    name: z.string(),
    product: z.string(),
    quantity: z.number(),
    unitPrice: z.number(),
  }),
});
// → { name: "John Smith", product: "widgets", quantity: 3, unitPrice: 10 }
```

### Classify (categorization)

```typescript
const [topLabel] = await ctx.ai.classify({
  text: "I was charged twice for my subscription",
  labels: ["billing", "technical", "general", "account"],
});
// → "billing"
```

### Retrieve (RAG)

```typescript
const chunks = await ctx.ai.retrieve({
  query: "How do I reset my password?",
  corpus: "support-docs",  // optional; omit to search the default corpus
  limit: 5,
  minScore: 0.7,
  // filter: { audience: "user", locale: "en" },  // optional metadata predicate
});
// → [{ content: "...", score: 0.92, metadata: {...} }, ...]
```

## AI Request Lifecycle

```
ctx.ai.generate()
       │
       ▼
┌──────────────┐
│Prompt Registry│ ← Look up prompt definition
└──────┬───────┘
       │
┌──────▼───────┐
│Security Check│ ← PII detection, scope verification
└──────┬───────┘
       │
┌──────▼───────┐
│Budget Check  │ ← Daily cost limit, per-call estimation
└──────┬───────┘
       │
┌──────▼───────┐
│Provider Call │ ← OpenAI / Anthropic API
└──────┬───────┘
       │
┌──────▼───────┐
│Output Valid. │ ← Zod schema validation (retry on failure)
└──────┬───────┘
       │
┌──────▼───────┐
│Record:       │
│• Cost        │ ← Token usage → dollar amount
│• Audit       │ ← Who called what prompt
│• Explain     │ ← Explainability trail
└──────┬───────┘
       │
       ▼
  Typed result
```

## AI Providers

Plumbus supports pluggable AI providers:

### OpenAI

```typescript
import { createOpenAIAdapter } from "@plumbus/core";

const provider = createOpenAIAdapter({
  apiKey: process.env["OPENAI_API_KEY"]!,
  model: "gpt-4o-mini",
});
```

### Anthropic

```typescript
import { createAnthropicAdapter } from "@plumbus/core";

const provider = createAnthropicAdapter({
  apiKey: process.env["ANTHROPIC_API_KEY"]!,
  model: "claude-sonnet-4-20250514",
});
```

## Cost Tracking

Every AI call is tracked:

```typescript
import { createCostTracker } from "@plumbus/core";

const tracker = createCostTracker({
  dailyBudget: 50.00,  // $50/day limit
  currency: "USD",
});

// Check budget before call
const check = tracker.checkBudget(estimatedCost);
if (!check.allowed) {
  throw new Error(`Budget exceeded: ${check.reason}`);
}
```

## Output Validation

AI outputs are validated against the Zod schema defined in the prompt. If validation fails, the framework can retry with a refined prompt. Structured JSON responses go through a conservative normalization pass first, so fenced JSON and raw newlines inside string fields do not immediately fail validation.

```typescript
import { generateWithValidation } from "@plumbus/core";

const result = await generateWithValidation({
  provider,
  prompt: promptDef,
  input: { ticketText: "..." },
  maxRetries: 2,  // Retry up to 2 times on validation failure
});
```

## RAG Pipeline

The Retrieval-Augmented Generation pipeline:

```
┌─────────────────┐
│ Document Ingest │
│                 │
│ plumbus rag     │
│   ingest ./docs │
└────────┬────────┘
         │
┌────────▼────────┐
│   Chunking      │
│                 │
│ Split into      │
│ 512-token chunks│
│ with overlap    │
└────────┬────────┘
         │
┌────────▼────────┐
│  Embedding      │
│                 │
│ OpenAI          │
│ text-embedding  │
│ -3-small        │
└────────┬────────┘
         │
┌────────▼────────┐
│  Vector Store   │
│                 │
│ Store chunks    │
│ with embeddings │
│ and metadata    │
└─────────────────┘
```

Retrieval:

```typescript
const results = await ctx.ai.retrieve({
  query: "password reset instructions",
  corpus: "support-docs",
  limit: 5,
  minScore: 0.7,
});
```

## Security Controls

AI requests are subject to security checks:

- **PII Detection** — warns if input contains personal data
- **Data Classification** — blocks sending highly_sensitive data to AI
- **Scope Verification** — caller must have appropriate scopes
- **Model Restrictions** — prompts specify allowed models

## File Convention

```
app/prompts/
├── summarize-ticket.prompt.ts
├── classify-intent.prompt.ts
└── extract-entities.prompt.ts
```

---

## SDK reference

For every `definePrompt` option — including advanced flags (`skipStreamValidationFallback`, `disableTextModeBrevityHint`, `appendUnsubstitutedInput`, `disableStrictStructuredOutputs`, `requireStrictStructuredOutputs`, `structuredOutputTransport`), `domain`, `tags`, `owner`, and the full `ModelConfig` shape — see [SDK Reference → definePrompt](../sdk-reference/define-functions.md#defineprompt). This page covers the common case; the reference is exhaustive.

