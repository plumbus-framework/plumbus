# AI Runtime

Plumbus provides structured AI interactions through prompts and the `ctx.ai` service.

## Defining a Prompt

```ts
import { definePrompt } from "@plumbus/core";
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

Prompts should NOT hardcode `provider` or model `name` unless you have a deliberate per-prompt override. Prefer env-based resolution (`AI_DEFAULT_*`, `PROMPT_{NAME}_*`) or `resolveAiOverrides` in `app/server.ts`. Only set `temperature`, `maxTokens`, and (when needed for OpenAI o-series / gpt-5) `reasoningEffort` in the prompt definition when tuning is part of the contract. Bare `z.string()` outputs run in plain text mode. See `prompts.md` for `system`/`description` content and the full `ModelConfig` table.

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

Ingest documents with `plumbus rag ingest <path>` (see `cli.md`).

### Generate With Usage

Returns validated output plus token counts and per-request cost:

```ts
const { data, usage, model, provider, cost } = await ctx.ai.generateWithUsage({
  prompt: "summarizeTicket",
  input: { ticketText: input.text, customerTier: "enterprise" },
});
```

`generateWithUsage` is **overloaded**: called without `tools` (as above) it returns the flat `AIFinalGenerateResult` — `.data` is always present, plus a `finishReason`. Called **with** `tools` it returns the discriminated `AIToolEnabledGenerateResult` (see [Tool calling](#tool-calling-provider-native)).

### Tool calling (provider-native)

Pass `tools` to `generate` / `generateWithUsage` to let the model call functions natively. Both built-in adapters implement caller tools on the wire (OpenAI `tools`/`tool_calls`; Anthropic `tool_use`/`tool_result` + `input_schema`). Build each `AITool.parameters` from `zodToProviderJsonSchema(schema).schema`:

```ts
import type { AITool } from "@plumbus/core";

const tools: AITool[] = [
  {
    name: "lookupOrder",
    description: "Look up an order by id",
    parameters: zodToProviderJsonSchema(lookupOrderInput).schema,
  },
];

const result = await ctx.ai.generateWithUsage({
  prompt: "assistant.turn",
  input: { userMessage },
  tools,
  toolChoice: "auto",                 // 'auto' | 'none' | { type: 'function', function: { name } }
  toolExecution: { parallelToolCalls: false },
  outputValidation: "none",            // disable output-schema validation during tool rounds
});

if (result.finishReason === "tool_calls") {
  for (const call of result.toolCalls) {
    // call.argumentsStatus is 'parsed' | 'invalid' — only execute 'parsed' calls.
    // The tool-calls branch has NO `.data`.
  }
} else {
  result.data; // final structured answer (flat AIFinalGenerateResult)
}
```

**Result typing.** A no-tools call returns `AIFinalGenerateResult<T>` (`.data` unconditional — back-compatible). A tools-enabled call returns `AIToolEnabledGenerateResult<T>`, a union keyed on `finishReason`: `'tool_calls'` carries `toolCalls` and no `.data`; any other reason carries `.data` and no `toolCalls`. Narrow on `finishReason` before touching `.data`.

**Bounded loop — `runToolLoop`.** For a full request→tool→observe→request loop, use `runToolLoop` (imported from `@plumbus/core`) instead of hand-rolling one:

```ts
import { runToolLoop } from "@plumbus/core";

const { final, messages, rounds } = await runToolLoop(ctx.ai, {
  prompt: "assistant.turn",           // a registered prompt NAME
  input: { userMessage },
  tools,
  execute: async (call) => {          // only receives 'parsed' calls
    return runMyTool(call.name, call.arguments);
  },
});
// final is a flat AIFinalGenerateResult; final.data is the answer.
```

`runToolLoop` defaults to `maxRounds: 8` (hard cap 20). On round exhaustion it makes ONE final request that **omits both `tools` and `toolChoice`** (never `toolChoice: 'none'`), so it always resolves to a non-tool answer. Invalid-argument tool calls are **never** executed — they surface to the model as a bounded `tool_arguments_invalid` observation. Observations are byte-bounded and wrapped in an `untrusted_tool_result` envelope.

An external `AIProviderAdapter` that omits the optional `capabilities` field is treated as declaring every capability `false` (no tool support).

> `@plumbus/chat`'s tool calling (`policy.toolCalling`, Path B) runs its **own** bounded loop with a different default (`maxToolRounds: 5`) — it does **not** call `runToolLoop`. Use `runToolLoop` for capability/flow authors and standalone `ctx.ai` tool loops, not to reimplement chat.

### Stream Generate

Stream partial output for long-running generations:

```ts
for await (const event of ctx.ai.streamGenerate({
  prompt: "writeChapter",
  input: { topic: input.topic },
})) {
  if (event.type === "delta") process.stdout.write(event.text);
}
```

### Multi-turn messages

Pass explicit chat messages instead of a named prompt:

```ts
await ctx.ai.generate({
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: input.question },
  ],
});
```

### Cost helpers

- `ctx.ai.checkProviderCostBudget()` — pre-flight budget check before provider calls
- `ctx.ai.recordProviderCost()` — record spend from external provider usage APIs

## Output Validation

All AI responses are validated against the prompt's output Zod schema. On failure, the framework retries generation (configurable). If retries are exhausted, a structured error is raised.

## Cost Tracking

Every AI invocation records: model used, input/output token counts, latency, and prompt name. Token counts come directly from provider responses.

**Per-request cost** is computed automatically from a built-in pricing table (`calculateModelCost`) covering major OpenAI and Anthropic models. Unknown models (Ollama, custom endpoints) return cost `$0`. Cached-token and long-context adjustments are applied when providers return cache metadata.

`generateWithUsage()` and `streamGenerate()` expose `cost` on each call. Budget limits (`BudgetConfig`) can gate requests by tokens or dollar amounts.

**Optional billing reconciliation:** use `createUsageAPIClient()` + `createCostTracker().syncCosts()` to pull actual invoices from provider billing APIs — this supplements, but does not replace, per-request cost from the pricing table:

```ts
import { createUsageAPIClient, createCostTracker } from "@plumbus/core";

const openaiUsage = createUsageAPIClient({
  provider: "openai",
  apiKey: process.env.AI_OPENAI_API_KEY,
});

const costTracker = createCostTracker(budgetConfig, [openaiUsage]);
const result = await costTracker.syncCosts();
```

## Configuration via Environment Variables

Use `loadConfig()` from `@plumbus/core` in your `config/app.config.ts` — it reads AI provider settings from env vars automatically.

### Single Provider

```bash
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_BASE_URL=https://custom-endpoint.com/v1   # optional, omit for default
AI_MODEL=gpt-4o-mini
```

### Multi-Provider

Set `AI_DEFAULT_PROVIDER` to enable multi-provider mode. Env-based discovery supports **only** `AI_OPENAI_*` and `AI_ANTHROPIC_*` slots — other `AI_{NAME}_API_KEY` values are ignored with a warning. Wire additional providers programmatically via `createProviderAdapter` / `createAIService`.

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

1. **Dynamic overrides** (`resolveAiOverrides` hook) — highest priority
2. **Per-prompt env override** (`PROMPT_{NAME}_MODEL`)
3. **Prompt definition** (`model.name` in `definePrompt`) — if set
4. **Default model** (`AI_DEFAULT_MODEL`) — global fallback

Provider resolution follows the same chain: dynamic override → per-prompt env → prompt definition → `AI_DEFAULT_PROVIDER`.

## Dynamic AI Config (DB Overrides)

For runtime model configuration (e.g. admin dashboard changing models without restart), export a `resolveAiOverrides` function from `app/server.ts`:

```ts
import type { ServerConfig } from '@plumbus/core';
import { sql } from 'drizzle-orm';

export const resolveAiOverrides: NonNullable<ServerConfig['resolveAiOverrides']> = async (db) => {
  const rows = await db.execute(sql`SELECT config_key, config_value FROM ai_config`);
  // Parse rows into override format and return
  return {
    defaultModel: 'gpt-4o',        // override global default
    defaultProvider: 'openai',      // override global provider
    promptOverrides: {              // per-prompt overrides (key = lowercase, dots → underscores)
      interview_ask_next_question: { model: 'gpt-4o', temperature: 0.7 },
    },
  };
};
```

The framework calls this hook before each `generate()`, `generateWithUsage()`, and `streamGenerate()` call. Dynamic overrides merge with and take priority over env-based config.

**Important**: The resolver should implement caching (e.g. 60-second TTL) to avoid querying the database on every AI call. API credentials (API keys) always come from environment variables — only model selection, temperature, and maxTokens should be stored in the database.

## Security

Classified-field scanning is **opt-in**. It runs only when `aiProviders.security` is set in config or via `AI_SECURITY_*` env vars. Omit the block entirely to leave AI calls unscanned (capability `access` policies still apply).

When configured:

| Mode | Behavior |
|------|----------|
| `redact` (default) | Warn at `warnThreshold`; replace fields at/above `redactThreshold` with `[REDACTED]` and continue |
| `block` | Abort the AI call when any field at/above `warnThreshold` is detected (`AISecurityBlockedError`) |

Entity definitions are merged from the registry when the `security` block is present. Thresholds: `warnThreshold` / `redactThreshold` on config, or `AI_SECURITY_WARN_THRESHOLD` / `AI_SECURITY_REDACT_THRESHOLD`. Invalid `AI_SECURITY_MODE` values warn at load and fall back to `redact`.

Also:

- Tenant isolation is enforced — prompts cannot access cross-tenant data
- All AI invocations are recorded in the audit trail

See `docs/ai/ai-integration.md` and `docs/upgrading-contract-alignment.md` §12.
