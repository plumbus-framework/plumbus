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
│  │              ctx.ai Service                           │  │
│  │  recordProviderCost() | generate() | generateWithUsage()  │  │
│  │  streamGenerate() | extract() | classify() | retrieve()   │  │
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
import { definePrompt } from "@plumbus/core";
import { z } from "zod";

export const classifyTicket = definePrompt({
  name: "classifyTicket",
  system: "You classify support tickets. Return only the requested fields.",
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
    name: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 256,
  },
});
```

`system` is optional. Use it for stable provider-level instructions such as role,
safety, output policy, or language policy. `description` remains the user/data
message. Both fields support simple top-level `{{key}}` substitution from the
prompt input, and prompts without `system` keep the old single-message behavior.
If a prompt renders a complete user message into one placeholder, set
`appendUnsubstitutedInput: false` to prevent remaining input keys from being
appended as `Input: {...}`.

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

### Generate With Usage (Token Tracking)

When you need actual token counts (e.g., for accurate cost recording):

```typescript
const { data, usage, model, provider, cost } = await ctx.ai.generateWithUsage({
  prompt: "classifyTicket",
  input: { ticketText: input.body },
});
// data = { department, urgency, confidence }
// usage = { inputTokens: 498, outputTokens: 48, totalTokens: 546,
//           cachedInputTokens: 200, cacheWriteTokens: 0 }
// model = "gpt-4o-mini"
// provider = "openai"
// cost = 0.000045
```

`generate()` returns only the data; `generateWithUsage()` returns `{ data, usage, model, provider, cost }`.

For structured-output prompts, you can override validation retries per request when you need faster failure or different retry behavior for one call site:

```typescript
await ctx.ai.generateWithUsage({
  prompt: "timeline.propose_periods",
  input: { events, language: "en" },
  validation: { maxRetries: 0, feedbackOnError: false },
});
```

When structured-output validation still fails, Plumbus throws an `AIValidationError`. The error carries `attempts`, `rawOutput` (final raw model completion), `validationMessage`, and — new in 0.3.0 — `usage`, `model`, and `provider` so failure-path cost recording knows what the provider actually billed across the retry loop. Catch it in capability handlers to surface a structured error to the caller instead of a generic 500.

### streamGenerate (streaming completions)

`ctx.ai.streamGenerate({ prompt, input, ... })` yields `AIStreamEvent` values (`delta` with partial text, then `done` with validated `data` and usage, or `error`). Token accounting and optional `onAICostRecorded` behave like non-streaming calls. Streaming uses the same prompt registry, substitution, validation, and structured-output paths as `generate()`.

### Native multi-turn (`messages`)

Optional **`messages`**: `Array<{ role: 'user' | 'assistant'; content: string }>`.

When **`messages` is non-empty**, the OpenAI and Anthropic adapters send `[system?, ...messages]` to the provider. The **`prompt` field on the wire is not used as an extra user message** in that mode. The AI service merges the rendered description (`system` + `description` from `buildPromptText`) into the provider **`system`** block so template-backed context is not dropped.

Use this for real chat transcripts instead of concatenating history into one giant `input` blob. The **last** entry should normally be **`user`** when the model is answering the latest user turn.

Supported on **`generate`**, **`generateWithUsage`**, and **`streamGenerate`**. Omit `messages` for existing single-turn prompts.

```typescript
import type { ChatMessage } from "@plumbus/core";

const messages: ChatMessage[] = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi — what would you like to record?" },
  { role: "user", content: "I grew up in Boston." },
];

for await (const ev of ctx.ai.streamGenerate({
  prompt: "interview.ask_next_question",
  input: { language: "en", subjectName: "Alex" /* ...other template fields */ },
  messages,
})) {
  if (ev.type === "delta") process.stdout.write(ev.text ?? "");
}
```

`ChatMessage` is a discriminated union: `{ role: 'user'; content }`, `{ role:
'assistant'; content; toolCalls? }`, or `{ role: 'tool'; content; toolCallId; name }`.
The plain user/assistant forms above stay construction-compatible.

### Provider-native tool calling

Pass `tools` (and optionally `toolChoice`, `toolExecution`) to `generate` /
`generateWithUsage`. Both built-in adapters implement caller tools natively — Anthropic
via `tool_use` / `tool_result` + `input_schema`, OpenAI via `tools` / `tool_calls`. Build
each `AITool.parameters` from `zodToProviderJsonSchema(schema).schema`.

```typescript
import type { AITool } from "@plumbus/core";

const tools: AITool[] = [
  { name: "lookupOrder", description: "Look up an order by id",
    parameters: zodToProviderJsonSchema(lookupOrderInput).schema },
];

const result = await ctx.ai.generateWithUsage({
  prompt: "assistant.turn",
  input: { userMessage },
  tools,
  toolExecution: { parallelToolCalls: false },
  outputValidation: "none", // disable output-schema validation during tool rounds
});

if (result.finishReason === "tool_calls") {
  for (const call of result.toolCalls) {
    // call.argumentsStatus is 'parsed' | 'invalid' — only execute 'parsed'
  }
} else {
  result.data; // final structured answer (flat AIFinalGenerateResult)
}
```

**Result typing (overloads).** A call with **no** tools returns the flat
`AIFinalGenerateResult<T>` whose `.data` is always present (back-compat). A call **with**
`tools` returns the discriminated union `AIToolEnabledGenerateResult<T>` keyed on
`finishReason` (`'tool_calls'` carries `toolCalls` and no `.data`; otherwise `.data`).

**Bounded loops.** For a full request→tool→observe→request loop, use `runToolLoop`
(`packages/plumbus-core/src/ai/tool-loop.ts`): default `maxRounds` 8, hard maximum 20. On
round exhaustion the final request **omits both `tools` and `toolChoice`** (never
`toolChoice: 'none'`). Invalid-argument calls are never executed and surface as a
`tool_arguments_invalid` observation.

> `@plumbus/chat`'s Path B tool calling is a **separate** loop (default `maxToolRounds`
> 5); chat does **not** call `runToolLoop`. See [chat policies →
> Tool calling](../chat/policies.md#tool-calling-path-b).

An external adapter that omits the optional `AIProviderAdapter.capabilities` field is
treated as declaring every capability `false` (no tool support).

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

### Multi-Provider Setup

Plumbus supports multiple AI providers simultaneously. Each prompt can specify which provider to use via `model.provider`; prompts without a provider field use the configured default.

For OpenAI chat completions, Plumbus maps prompt `maxTokens` to the provider-specific request
field expected by the selected model. Older models receive `max_tokens`; newer completion models
such as `gpt-5*` and `o*` receive `max_completion_tokens`.

```typescript
import { createAIService, createProviderAdapter } from "@plumbus/core";

const service = createAIService({
  providers: {
    openai: createProviderAdapter("openai", { apiKey: "sk-..." }),
    anthropic: createProviderAdapter("anthropic", { apiKey: "ant-..." }),
    ollama: createProviderAdapter("ollama", {
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
    }),
  },
  defaultProvider: "openai",
});
```

Then in prompt definitions:

```typescript
const writeBio = definePrompt({
  name: "writeBio",
  description: "Write a biography for {{name}}",
  input: z.object({ name: z.string() }),
  output: z.object({ biography: z.string() }),
  model: { provider: "anthropic", name: "claude-sonnet-4-20250514", temperature: 0.7 },
});

const extractFacts = definePrompt({
  name: "extractFacts",
  description: "Extract facts from text",
  input: z.object({ text: z.string() }),
  output: z.object({ facts: z.array(z.string()) }),
  model: { provider: "openai", name: "gpt-4o-mini", temperature: 0.1 },
});
```

The `extract()` and `classify()` convenience methods always use the default provider.

### Configuration and model resolution

`loadConfig()` reads AI settings from environment variables when building `config/app.config.ts`:

| Variable | Purpose |
|----------|---------|
| `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` | Single-provider mode |
| `AI_DEFAULT_PROVIDER` | Multi-provider default (`openai`, `anthropic` only via env) |
| `AI_OPENAI_*` / `AI_ANTHROPIC_*` | Per-provider API keys, base URLs, and default models |
| `AI_DEFAULT_MODEL` | Global model fallback for all prompts |
| `PROMPT_{NAME}_{FIELD}` | Per-prompt overrides (`PROVIDER`, `MODEL`, `TEMPERATURE`, `MAX_TOKENS`; dots → underscores, uppercased) |

Env discovery supports only `AI_OPENAI_*` and `AI_ANTHROPIC_*`. Other `AI_{NAME}_API_KEY` values log a warning and are ignored — wire Ollama and custom providers programmatically.

**Resolution order** for each call: `resolveAiOverrides` hook (from `app/server.ts`) → per-prompt env vars → prompt `model` fields → `AI_DEFAULT_MODEL` / `AI_DEFAULT_PROVIDER`.

Hardcoding `model.provider` and `model.name` in `definePrompt()` is valid when you want the contract to pin a model; omit them when you prefer env-driven resolution.

### Transient Provider Failures

Plumbus automatically retries transient upstream provider responses for AI requests. OpenAI-compatible and Anthropic adapters retry status codes `408`, `429`, `500`, `502`, `503`, and `504` with short exponential backoff before failing the request.

If those retries are exhausted, the capability returns a retryable internal error with HTTP status `503` so clients can tell the user the AI provider is temporarily unavailable and invite them to try again.

### Single Provider (Legacy)

For single-provider setups, use `singleProviderConfig()`:

```typescript
import { createAIService, singleProviderConfig, createOpenAIAdapter } from "@plumbus/core";

const service = createAIService(singleProviderConfig(
  createOpenAIAdapter({ apiKey: "sk-..." }),
  { defaultModel: "gpt-4o-mini" },
));
```

### OpenAI

```typescript
import { createOpenAIAdapter } from "@plumbus/core";

const openai = createOpenAIAdapter({
  apiKey: process.env["OPENAI_API_KEY"]!,
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",  // optional
});
```

### Anthropic

```typescript
import { createAnthropicAdapter } from "@plumbus/core";

const anthropic = createAnthropicAdapter({
  apiKey: process.env["ANTHROPIC_API_KEY"]!,
  model: "claude-sonnet-4-20250514",
});
```

### OpenAI-Compatible (Ollama, Azure, etc.)

Unknown provider names use the OpenAI-compatible adapter:

```typescript
import { createProviderAdapter } from "@plumbus/core";

const ollama = createProviderAdapter("ollama", {
  apiKey: "",
  baseUrl: "http://localhost:11434/v1",
  model: "llama3",
});
```

### Listing Available Models

`adapter.listModels()` hits the provider's `/v1/models` endpoint and joins the
live id list against the framework's pricing catalog. The `kind` of each model
comes from the pricing-page section it appears under — no name-pattern matching.

```typescript
const openai = createOpenAIAdapter({ apiKey: process.env["OPENAI_API_KEY"]! });

// All models the API key can see, with kind + pricing.
const everything = await openai.listModels!();

// Just embedding models.
const embeddings = await openai.listModels!({ kind: "embedding" });

// Multiple kinds at once.
const callable = await openai.listModels!({ kind: ["text", "embedding"] });
```

Each returned `ProviderModel` carries:

```typescript
{
  id: "text-embedding-3-small",
  provider: "openai",
  kind: "text" | "embedding" | "moderation" | "image" | "audio" | "unknown",
  inputPerMTok: 0.02,        // null if the model isn't in the pricing catalog
  outputPerMTok: 0,          // null if the model isn't in the pricing catalog
  createdAt: "2024-01-25T19:38:00.000Z",
  ownedBy: "openai",         // OpenAI only
  displayName: "...",        // Anthropic only
}
```

**Filter semantics — official vs. custom endpoints:**

| Scenario                                          | No filter   | `{ kind: 'embedding' }`               |
| ------------------------------------------------- | ----------- | ------------------------------------- |
| Official OpenAI / Anthropic                       | Everything  | Just embeddings (unknowns excluded)   |
| Custom OpenAI-compatible (Ollama, OpenRouter, …)  | Everything  | Embeddings **+ all unknowns**         |

"Official" means `baseUrl === 'https://api.openai.com/v1'` for OpenAI and
`baseUrl === 'https://api.anthropic.com/v1'` for Anthropic. Any other base URL
is considered custom, and a `kind` filter will return unknown-kind models
alongside the catalog matches — useful when running Ollama or similar where
the framework can't classify the live ids.

**Error handling.** If the endpoint 404s (Azure OpenAI uses a different path,
some corporate proxies don't implement `/v1/models`) or the network fails, the
method returns `[]` and emits a single `console.warn` rather than throwing —
so a settings UI can render "no models" cleanly.

`listModels` is **optional** on `AIProviderAdapter`. Custom adapters that
don't implement it still satisfy the interface; callers should check with
`if (adapter.listModels)` before invoking.

## Output Validation

AI outputs are validated against the prompt's Zod output schema. On failure, the framework retries with an enriched prompt.

Before validation, the runtime now does a conservative normalization pass for structured JSON responses: it strips surrounding markdown code fences, extracts the JSON object if the model added prefatory text, and escapes raw control characters inside string fields. This recovers common provider quirks without silently accepting obviously truncated payloads.

When using `responseFormat: 'json'` (OpenAI's json_object mode), the framework automatically injects "Respond with a valid JSON object." into the prompt if the word "json" is not already present. This prevents the OpenAI API error requiring "json" in the prompt text.

### Strict Structured Outputs

Set `enableStrictStructuredOutputs: true` on `createAIService()` to have Plumbus convert each registered prompt's Zod output schema into provider-compatible JSON Schema and pass it to providers that support constrained decoding.

- OpenAI-compatible providers receive `response_format: { type: "json_schema", json_schema: { strict: true, ... } }`.
- Anthropic receives `output_config.format: { type: "json_schema", schema: ... }`.
- Single-string-field outputs such as `z.object({ content: z.string() })` stay in plain text mode for streaming and are not constrained.
- Prompts can opt out with `disableStrictStructuredOutputs: true` when their schema cannot fit the provider JSON Schema subset.
- Prompts can require strict mode with `requireStrictStructuredOutputs: true` — the AI service refuses to run the prompt unless it can send a provider JSON Schema, preventing silent fallback to prompt-only JSON instructions.
- Transport can be switched with `structuredOutputTransport: "tool"` to use strict tool-call arguments instead of `response_format`, for provider/prompt combinations where JSON-schema response content is weak but tool calls are reliable.

The conversion is also exposed as a standalone helper:

```typescript
import { zodToProviderJsonSchema, ProviderJsonSchemaError } from "@plumbus/core";

const { schema, warnings } = zodToProviderJsonSchema(myZodSchema, {
  promptName: "classifyTicket",
});
```

Returns a `ProviderJsonSchemaResult` with the converted JSON Schema and any constraint warnings. Throws `ProviderJsonSchemaError` if the input schema cannot be safely converted (e.g. unsupported union shapes, Anthropic complexity limits exceeded).

The converter enforces provider-safe schema rules before a request is sent: every object gets `additionalProperties: false`, unsupported numeric and string constraints are moved into field descriptions, `minItems` is clamped to `0` or `1`, and Anthropic's complexity counters are checked locally. If a model refuses a structured request, Plumbus throws `AIRefusalError`.

`AIIncompleteOutputError` is thrown when a provider stops due to `finish_reason: "length"` / `stop_reason: "max_tokens"` **and the call was a structured-output request** — that is, `responseFormat: "json"` or a `responseSchema` was set. Truncated JSON has no recovery path the framework can safely take, so it surfaces as an error instead of a generic parse failure. Free-text prompts (no schema, no JSON mode) hit the same provider stop reason but return the partial content unchanged; if you want them to fail loud you can inspect `AIStreamEvent.finishReason` on the `done` event, or `ProviderResponse.finishReason` on a direct adapter call.

```typescript
import { generateWithValidation } from "@plumbus/core";

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
Normalize JSON-like payload
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

Every AI call is metered. The framework automatically calculates per-request cost using published pricing rates from OpenAI and Anthropic.

### Automatic Per-Request Cost

`generateWithUsage()` returns a `cost` field with the dollar amount calculated from actual token usage:

```typescript
const { data, usage, cost } = await ctx.ai.generateWithUsage({
  prompt: "analyzeTicket",
  input: { text: input.body },
});
// cost = 0.00234 (USD)
```

Cost is computed by `calculateModelCost()` which uses a built-in pricing table covering all major OpenAI and Anthropic models. Unknown models (e.g., local Ollama) return cost 0.

### Cached Token Pricing

When providers return cache information, the framework adjusts pricing automatically:

- **Cached input tokens** (prompt cache hits) are charged at **0.1x** the base input rate
- **Cache write tokens** (new cache entries) are charged at **1.25x** the base input rate
- Standard (non-cached) input tokens are charged at the full base rate

The framework parses cache data from provider responses:
- **OpenAI**: `usage.prompt_tokens_details.cached_tokens`
- **Anthropic**: `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`

### Long Context Premium

For Claude Sonnet 4 and Claude Sonnet 4.5, Anthropic charges a premium when total input exceeds 200K tokens:

- Input rate: **2x** standard
- Output rate: **1.5x** standard

The framework detects this automatically based on the model name and total input token count.

### Budget Enforcement

```typescript
import { createCostTracker } from "@plumbus/core";

const tracker = createCostTracker({
  dailyCostLimit: 50.0,
});

// Token-oriented pre-check
const check = tracker.checkBudget({
  tenantId: "project-123",
  estimatedTokens: 1500,
});
if (!check.allowed) {
  console.error(check.reason);
}
```

`checkBudget()` now also accepts `estimatedCostUsd` for non-token workloads. Voice/media layers should calculate normalized USD with their own pricing helper, then pre-check the shared daily cap before opening a realtime session or calling STT/TTS:

```typescript
const mediaCheck = tracker.checkBudget({
  tenantId: "project-123",
  estimatedCostUsd: 0.42,
});
```

Inside an `ExecutionContext`, prefer the AI service helper:

```typescript
ctx.ai.checkProviderCostBudget({
  estimatedCostUsd: 0.42,
});
```

Cost records (`AICostRecord`) include:
- `promptName`, `provider`, `model`, `operation` (`"generate" | "extract" | "classify" | "embed" | "transcribe" | "synthesize" | "transport"`)
- `usage` — input/output token counts including `cachedInputTokens` / `cacheWriteTokens`
- `mediaUsage` — optional voice/media billing units (`audioInputSeconds`, `audioOutputSeconds`, `characters`, `connectionMinutes`, `participantMinutes`)
- `cost` (USD) and `latencyMs`
- `timestamp`, `tenantId`, `actor`
- `status` — `"success" | "failed" | "refused" | "incomplete"`. Failed rows still represent real provider-side spend and count toward `dailyCostLimit`. Defaults to `"success"` for records created without an explicit status.
- `errorMessage` — short description when `status !== "success"`
- `fallbackUsed?: boolean` — set when a streaming `generate` call fell back to a non-streaming retry after the streamed text failed JSON/schema validation. Both attempts are billed; this flag is the duplicate-billing signal.

### Per-call cost context

Pass `costContext` on any `ctx.ai.*` call to attach billing metadata to the recorded `AICostRecord`. Useful for sharded ledgers and per-project cost rollups:

```typescript
import type { AICostContext } from "@plumbus/core";

await ctx.ai.generate({
  prompt: "summarizeTicket",
  input: { body: input.body },
  costContext: {
    projectId: input.projectId,
    serviceArea: "support",
    operationName: "summarize",
    relatedEntityType: "Ticket",
    relatedEntityId: input.ticketId,
  },
});
```

All fields are optional. Same shape is accepted on `generate`, `generateWithUsage`, `streamGenerate`, `extract`, and `classify`.

### Persisting a ledger with `onAICostRecorded`

Install `onAICostRecorded` on `ServerConfig` to receive every cost record after the in-memory tracker has been updated — including failure-path rows. The framework passes the active DB connection so you can write the ledger row in the same transactional scope as your domain data:

```typescript
import { createServer } from "@plumbus/core";

createServer({
  // ...
  onAICostRecorded: async (record, costContext, db) => {
    await db.insert(aiLedgerTable).values({
      ...record,
      projectId: costContext?.projectId,
      operationName: costContext?.operationName,
    });
  },
});
```

Hook errors are caught and logged; they never propagate to the AI caller.

### Voice / Media Costs

Voice integrations should write into the same ledger as text AI calls instead of maintaining a separate cost path. Use `ctx.ai.recordProviderCost(...)` when the provider interaction did not flow through `generate*`, `extract`, or `classify`:

```typescript
await ctx.ai.recordProviderCost(
  {
    model: "livekit-cloud",
    provider: "livekit",
    operation: "transport",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    mediaUsage: {
      connectionMinutes: sessionMinutes,
      participantMinutes: sessionMinutes * participantCount,
    },
    cost: transportUsd,
    latencyMs: sessionDurationMs,
  },
  {
    projectId,
    serviceArea: "voice",
    operationName: "voice.transport",
    relatedEntityType: "VoiceSession",
    relatedEntityId: sessionId,
  },
);
```

Typical voice operations are:

- `transcribe` for STT usage, usually with `mediaUsage.audioInputSeconds`
- `synthesize` for TTS usage, usually with `mediaUsage.characters` and/or `mediaUsage.audioOutputSeconds`
- `transport` for realtime session infrastructure, usually with `mediaUsage.connectionMinutes` and `mediaUsage.participantMinutes`

This keeps `onAICostRecorded` hooks, tenant rollups, and budget dashboards on one shared cost schema across text and voice workloads.

For the voice-specific runtime, provider, and security guidance, see:

- [`docs/voice/README.md`](../voice/README.md)
- [`docs/voice/cost-tracking.md`](../voice/cost-tracking.md)
- [`docs/voice/security.md`](../voice/security.md)

### Upgrading to `@plumbus/core` 0.6.0

`0.6.0` widens `AICostRecord.operation` with `transcribe`, `synthesize`, and `transport`. That is a **type-level breaking change** for apps that exhaustively `switch` on `operation` or persist it against a closed four-value set. Runtime behavior for existing text-AI workloads is unchanged.

**If you own a cost ledger or dashboard:**

1. Extend filters, enums, and exhaustive switches to include the three new operation kinds.
2. Allow optional `mediaUsage` on stored rows (seconds, characters, participant-minutes).
3. Route voice/media spend through `ctx.ai.recordProviderCost(...)` so `onAICostRecorded` stays the single hook.
4. Pre-check shared USD caps with `ctx.ai.checkProviderCostBudget({ estimatedCostUsd })` before opening realtime sessions or calling STT/TTS.

`@plumbus/voice` `0.3.x` peers on `@plumbus/core` `0.5.x || 0.6.x` (same literal as other optional add-ons). `@plumbus/chat`, `@plumbus/knowledge-base`, `@plumbus/browser-extension`, `@plumbus/mcp`, and `@plumbus/api` also declare `0.5.x || 0.6.x` and install alongside core **0.6.x**.

### Deterministic sampling with `seed`

For OpenAI-compatible providers (including xAI Grok), pass `seed` to pin reproducible output. Combined with `temperature: 0`, identical `{ seed, temperature, model, prompt }` tuples produce the same tokens. Ignored by providers that do not support it.

```typescript
const { data } = await ctx.ai.generateWithUsage({
  prompt: "planTimeline",
  input: { events },
  seed: 42,
});
```

## RAG Pipeline

### Ingestion

```bash
# CLI
plumbus rag ingest ./docs --source knowledge-base --classification internal
```

```typescript
// Programmatic
import { createRAGPipeline, createInMemoryVectorStore } from "@plumbus/core";

const vectorStore = createInMemoryVectorStore();
const rag = createRAGPipeline({
  provider: openaiAdapter,
  vectorStore,
  chunkConfig: { maxChunkSize: 1000, overlap: 200 },
});

await rag.ingest({
  documentId: "guide-001",
  content: "Document text...",
  source: "docs/guide.md",
  metadata: { category: "help" },
});
```

### Chunking

Documents are split into overlapping **character**-sized chunks:

```
┌─────────────────────────────────────────┐
│            Source Document               │
│                                         │
│  Chunk 1 (maxChunkSize chars)           │
│  ████████████████████                   │
│                 ████ ← overlap (chars)  │
│                 ████████████████████    │
│                 Chunk 2                 │
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
import { createExplainabilityTracker } from "@plumbus/core";

const tracker = createExplainabilityTracker({
  audit: ctx.audit,
  actor: "ai-runtime",
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
| Entity field classification | Recursively scans prompt input keys against registered entity field names and classifications |
| Mode `redact` (default) | Replaces fields at/above `redactThreshold` with `[REDACTED]` and continues |
| Mode `block` | Aborts the AI call when fields at/above `warnThreshold` are detected |
| Auto-wiring | When `aiProviders.security` is set, bootstraps merge the entity registry into `buildAISecurityConfig()` — omit `security` to leave scanning off |
| Model restriction | Prompts specify allowed models |
| Budget enforcement | Daily cost limits prevent runaway spending |

There is **no** separate `ai:generate` OAuth scope check in the AI runtime — access control for capabilities that call `ctx.ai.*` is enforced by each capability's `access` policy before the handler runs.

```
ctx.ai.generate() / generateWithUsage() / streamGenerate()
       │
       ▼
┌──────────────────┐
│ Field scan       │ ← Match input keys to entity field classifications
└──────┬───────────┘
       │
┌──────▼───────────┐
│ mode: redact     │ ← Replace at/above redactThreshold → continue
│ mode: block      │ ← Throw when at/above warnThreshold
└──────┬───────────┘
       │
       ▼
  Provider call
```

Configure via `aiProviders.security` in config or environment:

```bash
AI_SECURITY_MODE=redact          # or block
AI_SECURITY_WARN_THRESHOLD=sensitive
AI_SECURITY_REDACT_THRESHOLD=highly_sensitive
```

```typescript
aiProviders: {
  defaultProvider: "openai",
  providers: { /* ... */ },
  security: {
    mode: "redact",
    warnThreshold: "sensitive",
    redactThreshold: "highly_sensitive",
  },
},
```

Entity definitions are auto-populated from the entity registry at bootstrap. Use `buildAISecurityConfig()` when wiring a custom AI service.

## Testing AI

```typescript
import { mockAI, createTestContext } from "@plumbus/core/testing";

const ctx = createTestContext({
  ai: mockAI({
    generate: { department: "billing", urgency: "high", confidence: 0.95 },
  }),
});

// AI calls return mocked responses for the generate operation
const result = await ctx.ai.generate({
  prompt: "classifyTicket",
  input: { ticketText: "..." },
});
// → { department: "billing", urgency: "high", confidence: 0.95 }
```

`mockAI` keys responses by operation (`generate`, `extract`, `classify`, `retrieve`), not by prompt name.

