# AI Runtime

Plumbus provides structured AI interactions through prompts and the `ctx.ai` service.

## Defining a Prompt

```ts
import { definePrompt } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

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

Prompts should NOT hardcode `provider` or model `name` unless you have a deliberate per-prompt override. Prefer env-based resolution (`AI_DEFAULT_*`, `PROMPT_{NAME}_*`) or `resolveAiOverrides` in `app/server.ts`. Only set `temperature`, `maxTokens`, and provider-neutral `reasoning` when tuning is part of the contract. Bare `z.string()` outputs run in plain text mode. See `prompts.md` for `system`/`description` content and the full `ModelConfig` table.

## `ctx.ai` Operations

## Provider admission and trace propagation

Hosts can export `aiProviderConcurrency`, `resolveAIProviderHeaders`, and `onAIProviderSpan`
from `app/server.ts`. The concurrency ceiling is shared by every identity-bound AI service and
defaults to a scope of provider + tenant + `costContext.serviceArea`; saturation throws the
structured `ai-provider-concurrency-exhausted` refusal immediately rather than waiting. Override
`resolveScope` only when the host has another non-private package/workload key.

`resolveAIProviderHeaders` is called for every real provider attempt, including validation retries
and streams. Use it for W3C `traceparent`/`tracestate`; credential and content-type headers are
reserved and refused. `onAIProviderSpan` receives the completed client span and is best effort:
exporter failures never change the model-call result. Flow workers receive the persisted flow
correlation id in the same hook, so a host can preserve one trace across request → flow → provider.

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

**Start with [the classification recipe](ai-classification.md)** for provider/model
selection, TypeSafe/Jev, Laya, and OpenAI Decisions registration, defaults, thresholds,
and cost hooks (core **0.7.4+** / **0.8.0-beta.6+**). Use `classify()` for matching labels and `decide()`
for richer typed questions. Keep calls inside capabilities/flows.

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

`retrieve` passes its `signal` (inside flow steps `ctx.signal` by default) through the RAG pipeline to the adapter's `embed()` as `EmbeddingRequest.signal`: an abort ends the in-flight embedding request and skips the vector search. RAG `ingest`/`retrieve` take `signal` too. A custom `AIProviderAdapter.embed()` must pass `request.signal` to its transport.

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

On OpenAI reasoning models `usage.reasoningTokens` is the reasoning share of `outputTokens` (Chat Completions and the Responses API alike, summed over validation retries); it is already priced inside `outputTokens`, so never add it to a cost yourself.

With `enableStrictStructuredOutputs`, the OpenAI adapter sends an output whose root is not an object (`classify()`, a `z.array`/union/enum `extract()` schema or prompt `output`) inside a `{"value": …}` envelope and unwraps the answer itself, merges an `allOf` of several `.regex()`s into one schema, and names a `.default()` in the description (strict mode has no `default`); Zod still validates the original. For every provider the schema converter merges intersections of objects (`a.and(b)`, `a.and(b.optional())`, `a.and(b.nullable())`) into one object, sends `z.string().cidr()` as IPv4-or-IPv6 patterns, a tuple as an array of its item schemas (order in the description), and an optional output root as the value itself. Nothing to do in app code.

`usage.cacheWriteTokens` counts prompt tokens written to the provider cache (Anthropic, and OpenAI's `cache_write_tokens` on Chat Completions and the Responses API); like `cachedInputTokens` it is part of `inputTokens`. Cost charges them 1.25× input on Claude and OpenAI GPT-5.6+, and the input rate on earlier OpenAI models.

`generateWithUsage` also accepts per-call `provider`, `model`, and provider-neutral `reasoning` overrides:

```ts
await ctx.ai.generateWithUsage({
  prompt: 'assistant.turn',
  input: {},
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  reasoning: { mode: 'effort', effort: 'medium' },
});
```

A per-call `timeoutMs` (on `generate`, `generateWithUsage`, `streamGenerate`, `extract`, `classify`, `retrieve` and `runToolLoop`; `timeout` on `EmbeddingRequest`, `timeoutMs` on RAG `ingest`/`retrieve`) overrides the prompt's `model.timeoutMs` and the provider's `requestTimeout` for that call; see `prompts.md`. A request its timeout ends throws a non-retryable `ProviderAPIError` carrying `timeoutMs`; detect it with `isProviderTimeoutError(error)` from `@plumbus/core` (`isProviderAPIError` for any provider HTTP failure) instead of checking the error's shape, and raise the timeout rather than retrying.

Omit `reasoning` to inherit prompt/config; use `null` to restore the provider/model default for one call, clearing both inherited `reasoning` and inherited legacy `reasoningEffort`. Explicit modes are `{ mode:'disabled' }`, `{ mode:'effort', effort:'minimal'|'low'|'medium'|'high'|'xhigh'|'max' }`, and `{ mode:'budget', maxTokens }`. Built-in core adapters translate the intent: OpenAI uses Chat Completions normally and switches caller-tool requests, and the `structuredOutputTransport:'tool'` function, that need active/default GPT-5.6 or GPT-6 reasoning to the Responses API; Anthropic uses `thinking` + `output_config.effort`. GPT-6 Chat Completions use `max_completion_tokens`; GPT-6 requests omit sampling temperature unless reasoning is explicitly disabled. Responses tool continuations are stateless (`store:false`) and preserve encrypted reasoning items through server-owned `providerState`. Custom providers translate the contract in their own `AIProviderAdapter`. Unsupported modes fail with `AIInvalidRequestError` before provider I/O when the adapter can identify the incompatibility. No GPT-6 model accepts effort `minimal`, and `gpt-6-astra` / `gpt-6.1-sol` have no off switch (`{ mode:'disabled' }` fails; use `low`). Claude Fable 5.1/5, Mythos 5.1/5/Preview, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5, and Haiku 5.5 reject any `temperature` other than 1, so Plumbus omits both its `0.7` default and any explicitly configured temperature for them. On those models disabled is sent as `thinking: { type: 'between_tools' }` on `claude-sonnet-5-5` and fails on Opus 5.5, Fable, and Mythos (thinking cannot be turned off; lower the effort), and budgets fail on all but `claude-mythos-preview`. Deprecated `reasoningEffort` remains the unchanged OpenAI-only `'low' | 'medium' | 'high'` shorthand.

### Prompt caching (Anthropic / Bedrock)

Included in this beta family (stable core **0.7.9+**). Pass `cache: true` (system + tools) or `{ system?, tools?, messages? }` on `generate` / `generateWithUsage` / `streamGenerate` / `runToolLoop`. To make it the default for every call, set `AI_PROMPT_CACHE=true` (or sections such as `system,messages`); a per-call `cache` overrides it. Anthropic gets `cache_control`; Bedrock Claude gets Converse `cachePoint` (`@plumbus/ai-bedrock` from this beta family, or stable 0.2.2+), except Claude 3 Haiku / Sonnet / Opus and Claude 3.5 Sonnet `20240620`, which reject it, and Claude 3.5 Sonnet v2 (Preview-only on Bedrock). OpenAI and non-Claude Bedrock models ignore the section flags. Shorter prompts may not meet provider minima — the call still succeeds.

OpenAI (core **0.9.0-beta.4+**): add `key` (sent as `prompt_cache_key`) and optionally `ttl: '30m' | '12h'` (sent as `prompt_cache_options: { ttl }`, documented by OpenAI for GPT-5.6+) to the cache object, on Chat Completions and the Responses API; Anthropic and Bedrock ignore both. Use one stable key for requests that share a prompt prefix (e.g. tenant + prompt name + prompt version) and never put end-user identifiers in it. `'12h'` is a Responses API value: a request the adapter sends through Chat Completions (no tools and no `structuredOutputTransport: 'tool'`, and every `stream`) does not send it, gets OpenAI's `'30m'` default, and the adapter warns once — use `'30m'` there.

`cache: true` marks only the system prompt and tools. In a single-turn call, a prompt's `description` and its input go into the user message, so keep long, stable instructions in `system`. In multi-turn mode (`messages` set), the description and `Input: {...}` are merged into the system prompt, so an input that changes between turns writes a new cache entry every turn.

```ts
await ctx.ai.generateWithUsage({
  prompt: 'classifyTicket',
  input: { ticketText },
  cache: true,
});
```

### Tool calling (provider-native)

Pass `tools` to `generate` / `generateWithUsage` to let the model call functions natively. Both built-in adapters implement caller tools on the wire (OpenAI `tools`/`tool_calls`; Anthropic `tool_use`/`tool_result` + `input_schema`). OpenAI caller tools are non-strict on both transports (the Responses API gets an explicit `strict: false`, since it would otherwise make every property required and the model would invent values for optional arguments), so optional arguments stay optional; still validate `call.arguments` with the tool's Zod input schema. Build each `AITool.parameters` from `zodToProviderJsonSchema(schema).schema`:

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

`runToolLoop` defaults to `maxRounds: 8` (hard cap 20). On round exhaustion it makes ONE final request that **omits both `tools` and `toolChoice`** (never `toolChoice: 'none'`), so it always resolves to a non-tool answer. Invalid-argument tool calls are **never** executed — they surface to the model as a bounded `tool_arguments_invalid` observation. Observations are byte-bounded and wrapped in an `untrusted_tool_result` envelope. Pass `cache: true` to reuse the cached system prompt and tools across rounds (core 0.7.9+); it is forwarded to every request.

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

**Per-request accounting** uses `estimateModelCost()` and the fixed pricing catalog. The legacy `calculateModelCost()` and generation `cost` remain numeric for compatibility, but an unknown model produces `costAvailable: false`; it must be recorded as `null` in a custom ledger. Use `aggregatedCostAvailable` for tool-loop totals and `costAvailable` for embedding callbacks. Explicit free costs remain zero/available. Cached-token and long-context adjustments use provider usage metadata. Sol's bundled window uses $4/$20 ($0.40 cached input) before `2026-11-22T00:00:00.000Z`, then $5/$30 ($0.50 cached input). This is a static accounting fallback after the minimum guaranteed promotional period, not a confirmed provider expiry. Do not add runtime pricing fetches.

**Provider-supplied cost:** when an adapter sets `cost` on `ProviderResponse` / stream `done` (Amazon Bedrock via `@plumbus/ai-bedrock`), `createAIService` **prefers that value** over `MODEL_PRICING`. Bedrock never returns USD — the add-on multiplies usage × AWS Price List rates (auto-download or `AI_BEDROCK_PRICING_FILE`). Do not alias Bedrock rates to Anthropic catalog rows.

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

Set `AI_DEFAULT_PROVIDER` to enable multi-provider mode. Env-based discovery supports **`AI_OPENAI_*`**, **`AI_ANTHROPIC_*`**, and **`AI_BEDROCK_*`** (region-based; no API key). Other `AI_{NAME}_API_KEY` values are ignored with a warning. Wire additional providers programmatically through `createAIService` and a custom `AIProviderAdapter`.

A present-but-empty API-key slot is treated as unset — the slot is skipped so a leftover blank dotenv line does not crash worker boot. If that provider is the default, set a real key. Do not invent a placeholder key to “satisfy” validation.

```bash
AI_DEFAULT_PROVIDER=openai

AI_OPENAI_API_KEY=sk-...
AI_OPENAI_BASE_URL=https://custom-openai.com/v1   # optional
AI_OPENAI_MODEL=gpt-4o-mini

AI_ANTHROPIC_API_KEY=sk-ant-...
AI_ANTHROPIC_BASE_URL=https://custom-anthropic.com  # optional
AI_ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

Each provider slot (`AI_` single-provider, `AI_OPENAI_`, `AI_ANTHROPIC_`, `AI_BEDROCK_`) also reads `REQUEST_TIMEOUT` (a whole number of ms from 1 to 2147483647), `MAX_TOKENS` (a whole number of tokens, 0 or more) and `DAILY_COST_LIMIT` (US dollars, 0 or more, e.g. `10.5`); Bedrock also `AI_BEDROCK_PRICING_TTL_MS` (whole ms, 0 or more). Write plain numbers, never units: `15m`, `4k`, `$50` or `abc` make `loadConfig()` throw naming the variable (e.g. `Invalid AI_OPENAI_REQUEST_TIMEOUT="15m": expected a whole number of milliseconds from 1 to 2147483647`), so the process does not start; a blank value is unset.

### Amazon Bedrock

Requires `@plumbus/core` **≥ 0.7.0** (prompt caching needs core **≥ 0.7.9** and `@plumbus/ai-bedrock` **≥ 0.2.2**).

```bash
pnpm add @plumbus/ai-bedrock@plumbus-next
```

```bash
AI_DEFAULT_PROVIDER=bedrock
AI_BEDROCK_REGION=us-east-1
AI_BEDROCK_MODEL=anthropic.claude-sonnet-4-5-20250929-v1:0
# containers (recommended) — mount normalized rates; no Price List CDN egress:
# AI_BEDROCK_PRICING_FILE=/config/bedrock-pricing.json
```

Auth is IAM / IRSA / default credential chain (SDK may honor `AWS_BEARER_TOKEN_BEDROCK`). Price List URLs, curl, normalize script, ConfigMap:

- `node_modules/@plumbus/ai-bedrock/instructions/framework.md`
- `node_modules/@plumbus/ai-bedrock/instructions/pricing.md`

Example rates URL (public, no IAM):

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json
```

Each prompt's `model.provider` routes to the named provider; prompts without a provider field use `defaultProvider`.

### Default Model

Set a global fallback model that all prompts use unless overridden:

```bash
AI_DEFAULT_MODEL=gpt-4o
```

### Default Prompt Caching

Turn on Anthropic / Bedrock prompt caching for every call (see [Prompt caching](#prompt-caching-anthropic--bedrock)):

```bash
AI_PROMPT_CACHE=true            # system + tools; or e.g. system,tools,messages
```

### Per-Prompt Overrides

Override model, provider, temperature, maxTokens, or the request timeout for any specific prompt via env vars:

```bash
# Format: PROMPT_{NAME}_{FIELD}
# Name = prompt name with dots → underscores, UPPERCASED
# Fields: PROVIDER, MODEL, TEMPERATURE, MAX_TOKENS, TIMEOUT_MS

# Route "writer.write_chapter" to Anthropic:
PROMPT_WRITER_WRITE_CHAPTER_PROVIDER=anthropic
PROMPT_WRITER_WRITE_CHAPTER_MODEL=claude-sonnet-4-20250514

# Use a cheaper model for metadata extraction:
PROMPT_INTERVIEW_EXTRACT_METADATA_MODEL=gpt-4o-mini
```

The HTTP server and the worker pool (flows, jobs, event handlers) both apply these. Numeric fields are checked when the config loads — `TIMEOUT_MS` a whole number of ms from 1 to 2147483647, `MAX_TOKENS` a whole number ≥ 1, `TEMPERATURE` 0–2 — and anything else (`abc`, `0`, `15m`) makes `loadConfig()` throw naming the variable, so the process does not start; a blank value is no override.

### Model Resolution Chain

When a prompt is invoked, each field (`provider`, `model`, `temperature`, `maxTokens`, `reasoning`, `timeoutMs`) is resolved on its own, first set wins:

1. **Per-call value** (`provider`, `model`, `reasoning`, `timeoutMs` on `generate` / `generateWithUsage` / `streamGenerate`)
2. **Dynamic overrides** (`resolveAiOverrides` hook's `promptOverrides`)
3. **Per-prompt env override** (`PROMPT_{NAME}_*`)
4. **Prompt definition** (`model` in `definePrompt`) — if set
5. **Defaults** — the hook's `defaultModel` / `defaultProvider`, else `AI_DEFAULT_MODEL` / `AI_DEFAULT_PROVIDER`

A layer decides only the fields it sets: a hook override `{ model: 'gpt-4.1-mini' }` keeps the prompt's `PROMPT_{NAME}_MAX_TOKENS` and `PROMPT_{NAME}_TIMEOUT_MS`. When an override changes `provider`, set `model` with it, or the model of a lower layer goes to the new provider. `reasoning` and the deprecated `reasoningEffort` count as one field: the highest layer that sets either decides both.

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
    promptOverrides: {              // per-prompt overrides, keyed by prompt name
      'interview.ask_next_question': { model: 'gpt-4o', temperature: 0.7 },
    },
  };
};
```

The framework calls this hook before each `generate()`, `generateWithUsage()`, and `streamGenerate()` call, on the HTTP server and the worker pool alike. Its answer replaces the previous one (an override it stops returning no longer applies) and sits above the env config field by field, as in the chain above; unset fields keep the env and prompt values. Key `promptOverrides` by the prompt's name (`interview.ask_next_question`) or its env-style key (`interview_ask_next_question`, lower case, dots → underscores); when both are present, the entry under the name wins.

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
- Cost and explainability hooks depend on configured services; do not assume audit durability or complete pricing without checking that wiring.

See `docs/ai/ai-integration.md` and `docs/upgrading-contract-alignment.md` §12.


## Security release rules (core 0.7.0)

- `ctx.ai` is bound to the executing actor/tenant. Keep `withContext` on wrappers; never reuse another caller's bound service. Missing-tenant retrieval returns only unscoped documents.
- With security configured, generate/stream/extract/classify apply the field-classification policy. Extract/classify use the `text` field; arbitrary free-text PII is not automatically detected. Explainability stores redacted input.
- Unknown prior spend rejects further requests when a dollar cap is configured. Local/unpriced providers still work without dollar caps; explicit free prices stay supported. Never supply fake zero costs to bypass budgets.
- Read [the security release checklist](./upgrading-security-release.md) before upgrading custom cost hooks or AI wrappers.


## Typed decisions (core 0.7.4+ / 0.8.0-beta.6+)

For choices, scores, and probabilities, use `ctx.ai.decide()` inside capabilities
and flows. Define reusable contracts with `defineDecision` from
`@plumbus/ai-decision`; CLI startup discovers `app/decisions/`. The shared contract
package is provided by core; install only the TypeSafe, Laya, or OpenAI Decisions
provider required by the app. Export `decisions = { providers, defaultProvider }` from
`app/server.ts` for both API and workers, using `createTypeSafeDecisionAdapter`,
`createLayaDecisionAdapter`, or `createOpenAIDecisionAdapter` at that server-owned
boundary. Do not register these adapters as text-completion providers or call them
directly for app business logic.

Core records `operation: 'decide'` with actual model, usage, cost, tenant/actor,
optional `decisionName`, and the caller's `costContext`. Existing
`onAICostRecorded(record, costContext, db)` hooks persist these rows; include the
new operation in any app-owned ledger enum/schema. Failed responses and cancelled
calls also produce rows. Unknown USD cost is null, never a free zero. Security
scans state and structured questions; budgets are checked before provider work.
Use `mockAI({ decide: result })` and test through `runCapability`/`simulateFlow`.

Guide: https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md
