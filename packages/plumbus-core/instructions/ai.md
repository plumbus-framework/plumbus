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

  // provider and model are resolved from config/env at runtime — only set tuning params here
  model: {
    temperature: 0.3,
    maxTokens: 500,
  },
});
```

Prompts should NOT hardcode `provider` or model `name`. These are resolved at runtime through the configuration chain (see below). Only set `temperature` and `maxTokens` in the prompt definition.

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

Every AI invocation records: model used, input/output token counts, latency, and prompt name. Token counts come directly from provider responses and are always accurate.

**Actual costs** are fetched from provider usage APIs — the framework never guesses or hardcodes pricing. Use `createUsageAPIClient()` to configure OpenAI and Anthropic billing API access:

```ts
import { createUsageAPIClient, createCostTracker } from "plumbus-core";

const openaiUsage = createUsageAPIClient({
  provider: "openai",
  apiKey: process.env.AI_OPENAI_API_KEY,
});

const anthropicUsage = createUsageAPIClient({
  provider: "anthropic",
  apiKey: process.env.AI_ANTHROPIC_API_KEY,
});

const costTracker = createCostTracker(budgetConfig, [openaiUsage, anthropicUsage]);

// Fetch actual costs from billing APIs
const result = await costTracker.syncCosts();
if (!result.synced) {
  console.warn("Cost sync failed:", result.error);
}
```

If the usage API is not configured or unavailable, `cost` on each record is `null` and dollar-based budget limits cannot be enforced. Token-based budget limits always work.

Budget limits (per-request token limit, daily cost limit, per-tenant daily limit) are enforced via `BudgetConfig`.

## Configuration via Environment Variables

Use `loadConfig()` from `plumbus-core` in your `config/app.config.ts` — it reads AI provider settings from env vars automatically.

### Single Provider

```bash
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_BASE_URL=https://custom-endpoint.com/v1   # optional, omit for default
AI_MODEL=gpt-4o-mini
```

### Multi-Provider

Set `AI_DEFAULT_PROVIDER` to enable multi-provider mode. Providers are discovered from `AI_{NAME}_API_KEY` patterns:

```bash
AI_DEFAULT_PROVIDER=openai

AI_OPENAI_API_KEY=sk-...
AI_OPENAI_BASE_URL=https://custom-openai.com/v1   # optional
AI_OPENAI_MODEL=gpt-4o-mini

AI_ANTHROPIC_API_KEY=sk-ant-...
AI_ANTHROPIC_BASE_URL=https://custom-anthropic.com  # optional
AI_ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

Each prompt's `model.provider` routes to the named provider; prompts without a provider field use `defaultProvider`.

### Default Model

Set a global fallback model that all prompts use unless overridden:

```bash
AI_DEFAULT_MODEL=gpt-4o
```

### Per-Prompt Overrides

Override model, provider, temperature, or maxTokens for any specific prompt via env vars:

```bash
# Format: PROMPT_{NAME}_{FIELD}
# Name = prompt name with dots → underscores, UPPERCASED
# Fields: PROVIDER, MODEL, TEMPERATURE, MAX_TOKENS

# Route "writer.write_chapter" to Anthropic:
PROMPT_WRITER_WRITE_CHAPTER_PROVIDER=anthropic
PROMPT_WRITER_WRITE_CHAPTER_MODEL=claude-sonnet-4-20250514

# Use a cheaper model for metadata extraction:
PROMPT_INTERVIEW_EXTRACT_METADATA_MODEL=gpt-4o-mini
```

### Model Resolution Chain

When a prompt is invoked, the model is resolved in this order:

1. **Per-prompt env override** (`PROMPT_{NAME}_MODEL`) — highest priority
2. **Prompt definition** (`model.name` in `definePrompt`) — if set
3. **Default model** (`AI_DEFAULT_MODEL`) — global fallback

Provider resolution follows the same chain: per-prompt override → prompt definition → `AI_DEFAULT_PROVIDER`.

## Security

- Classified fields in prompt inputs are detected and warn/redact based on entity field classifications
- Tenant isolation is enforced — prompts cannot access cross-tenant data
- All AI invocations are recorded in the audit trail
