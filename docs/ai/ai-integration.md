# AI Integration Guide

Core **0.7.3+** (included in the core 0.8 and 0.9 families) also provides `ctx.ai.decide()` for typed decision providers
(`@plumbus/ai-decision-typesafe`, `@plumbus/ai-decision-laya`, and, in this beta family or with stable core 0.7.9+,
`@plumbus/ai-decision-openai`). It records `operation: 'decide'` through the existing cost tracker and
`onAICostRecorded` hook, including billed validation failures and cancellations.
See [decision registration, named contracts, and accounting](./decision-providers.md#application-integration-and-cost-recording).


Plumbus provides a structured AI runtime with typed prompts, output validation, cost tracking, RAG, and security controls.

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                    AI Runtime                            │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Prompts  │  │ Providers    │  │ RAG Pipeline     │  │
│  │          │  │              │  │                  │  │
│  │ define   │  │ OpenAI*      │  │ Ingest → Chunk   │  │
│  │ Prompt() │  │ Anthropic*   │  │ → Embed → Store  │  │
│  │          │  │ Bedrock†     │  │ → Retrieve       │  │
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

* Built into @plumbus/core (fetch-based OpenAI/Anthropic adapters).
† Optional package @plumbus/ai-bedrock (AWS SDK) — install explicitly.
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
    // reasoning: { mode: "effort", effort: "medium" },
    // timeoutMs: 30_000, // per provider request; see "Request Timeouts"
  },
});
```

`system` is optional. Use it for stable provider-level instructions such as role,
safety, output policy, or language policy. `description` remains the user/data
message. Both fields support simple top-level `{{key}}` substitution from the
prompt input, and prompts without `system` keep the old single-message behavior.

Substitution is a **single pass over the original template**. Inserted values are
literal: `$` sequences (`$'`, `` $` ``, `$&`, `$1`, `$$`) are not JavaScript
replacement patterns, and `{{otherKey}}` inside a value is not expanded as a
later placeholder. The same fill is exported as `fillPromptTemplate` from
`@plumbus/core`.

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

On OpenAI reasoning models (o-series, `gpt-5*`, `gpt-6*`) `usage.reasoningTokens` is the part of `outputTokens` the model spent reasoning, on Chat Completions (`completion_tokens_details.reasoning_tokens`, streamed or not) and on the Responses API (`output_tokens_details.reasoning_tokens`) alike. It is already counted in `outputTokens`, which is what is priced, so it never adds to `cost`. It is summed over validation retries, tool-loop rounds and a streaming validation fallback, and kept on the `AICostRecord.usage` ledger row; it is absent when the provider does not report the split.

For a one-off override, `generateWithUsage` accepts `provider`, `model`, provider-neutral `reasoning`, and `timeoutMs` (see [Request Timeouts](#request-timeouts)); `generate` and `streamGenerate` accept the same. Leaving a field undefined preserves normal prompt/config resolution; `reasoning:null` restores the provider/model default for that call and clears both inherited `reasoning` and inherited legacy `reasoningEffort`. Use `{ mode:'disabled' }`, `{ mode:'effort', effort }`, or `{ mode:'budget', maxTokens }`. The selected adapter translates the intent into its native wire format and explicitly rejects modes it cannot represent. Legacy `reasoningEffort` remains exactly `'low' | 'medium' | 'high'` with its previous OpenAI-only behavior.

### Prompt caching (Anthropic / Bedrock)

Included in this beta family (stable core **0.7.9+**, with Bedrock **0.2.2+**). The Anthropic API only caches prompts the client marks with `cache_control`; Claude on Bedrock caches implicitly on a best-effort basis, and `cachePoint` marks make it explicit. Pass `cache` on `generate`, `generateWithUsage`, `streamGenerate`, or `runToolLoop` (which forwards it to every round):

```typescript
await ctx.ai.generateWithUsage({
  prompt: "classifyTicket",
  input: { ticketText },
  cache: true, // or { system: true, tools: true, messages: false }
});
```

To turn caching on for every call, set `AI_PROMPT_CACHE=true` (or a list of sections such as `system,messages`). `loadConfig()` stores it as `aiProviders.cache` (and `ai.cache` in single-provider mode), and the API server and workers pass it to `createAIService({ cache })`. Apps that build the service themselves pass `cache` there. A per-call `cache` overrides the default.

| Value | Effect |
| --- | --- |
| `true` | Cache system + tools (not messages) |
| `{ system?, tools?, messages? }` | Per-section control; omitted fields are `false` |
| `{ …, key?, ttl? }` | OpenAI only — see [OpenAI cache key and ttl](#openai-cache-key-and-ttl) |
| `false` | No marks, even when the default is on |

`cache: true` marks only the system prompt and tools. In a single-turn call, a prompt's `description` and its input go into the user message, so a prompt that keeps most of its text there gains little. In multi-turn mode (`messages` set), the description and `Input: {...}` are merged into the system prompt, so an input that changes between turns writes a new cache entry every turn. The same applies to input values substituted into `system` through `{{key}}`.

When enabled, adapters add provider marks:

| Surface | Anthropic | Bedrock (Converse) |
| --- | --- | --- |
| System | `[{ type:'text', text, cache_control:{ type:'ephemeral' } }]` | `{ cachePoint:{ type:'default' } }` after the system text |
| Tools | `cache_control` on the last tool | `cachePoint` at the end of `toolConfig.tools` |
| Messages | `cache_control` on the last message content block | `cachePoint` at the end of the last message |

OpenAI caches long prompts automatically and ignores the section flags (and `cache: true`). Bedrock emits `cachePoint` only for Claude model ids (`anthropic.claude…`, with or without an inference-profile prefix such as `us.`, `jp.` or `global.`; a model ARN gets none). It skips Claude 3 Haiku, Claude 3 Sonnet, Claude 3 Opus, and Claude 3.5 Sonnet `20240620`, which reject `cachePoint`, Claude 3.5 Sonnet v2 (`20241022`, explicit caching in Preview), and every non-Claude family (Nova caches on its own), so those requests still succeed. Providers also enforce a minimum prefix length; shorter prompts succeed without a cache write. Cache reads and writes come back as `usage.cachedInputTokens` / `usage.cacheWriteTokens` and are priced as before.

#### OpenAI cache key and ttl

Core 0.9.0-beta.4+. Two fields of the cache object are OpenAI options; Anthropic and Bedrock ignore them:

| Field | Sent as | Notes |
| --- | --- | --- |
| `key?: string` | `prompt_cache_key` | Requests that share a reusable prefix and a key are routed to the same cache. Before GPT-5.6 this raises hit rates; from GPT-5.6 it separates cache accounting. An empty string is not sent. |
| `ttl?: '30m' \| '12h'` | `prompt_cache_options: { ttl }` | Minimum lifetime of the cache entries the request writes. OpenAI documents `prompt_cache_options` for GPT-5.6 and later; `'30m'` is its default. `'12h'` (written at 2.5× the input rate instead of 1.25×) exists on the Responses API only — see below. Omitted → nothing is sent. |

Plumbus does not send the deprecated `prompt_cache_retention`.

**Which API a request uses.** The adapter picks the OpenAI API per request: the Responses API when the request continues a Responses turn, when it has caller tools under active reasoning (or tools on GPT-5.6 / GPT-6 with no reasoning set), or when `structuredOutputTransport: 'tool'` is used on GPT-5.6 / GPT-6; Chat Completions otherwise, and always for `stream`. Because the caller cannot see that choice in the types, a `'12h'` ttl on a request that goes through Chat Completions is **not sent**: OpenAI applies its `'30m'` default, the key is still sent, and the adapter logs one `console.warn` per adapter instance (`OpenAI cache ttl '12h' is a Responses API value; …`). Use `'30m'` (or omit `ttl`) on Chat Completions requests.

Both are written on Chat Completions (`complete` and `stream`) and on the Responses API. `cache: true`, `false`, or an object without them sends neither.

```typescript
await ctx.ai.generateWithUsage({
  prompt: "summarizeCourse",
  input,
  // Group requests that share the prompt prefix; never put end-user identifiers in the key.
  cache: { system: true, key: `${tenantId}:summarizeCourse:v3` },
});
```

OpenAI recommends about 15 requests per minute per key for busy groups; split higher traffic across several keys with a stable mapping. A service default (`createAIService({ cache: { key, ttl } })` or the `ai.cache` / `aiProviders.cache` config) applies only when a call sets no `cache`, because a per-call option replaces the default as a whole. `AI_PROMPT_CACHE` sets sections only.

For structured-output prompts, you can override validation retries per request when you need faster failure or different retry behavior for one call site:

```typescript
await ctx.ai.generateWithUsage({
  prompt: "timeline.propose_periods",
  input: { events, language: "en" },
  validation: { maxRetries: 0, feedbackOnError: false },
});
```

When structured-output validation still fails, Plumbus throws an `AIValidationError`. The error carries `attempts`, `rawOutput` (final raw model completion), `validationMessage`, and — new in 0.3.0 — `usage`, `model`, and `provider` so failure-path cost recording knows what the provider actually billed across the retry loop. `AIValidationError` is exported from `@plumbus/core`, alongside `AIRefusalError` and `AIIncompleteOutputError`, so `catch (err) { if (err instanceof AIValidationError) ... }` works in a capability handler — surface a structured error to the caller instead of a generic 500, and read `err.usage` when the host keeps its own spend ledger rather than using `onAICostRecorded`. It also carries `cost`: each attempt priced on its own usage (adapter cost, else the catalog), omitted when an attempt cannot be priced.

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

OpenAI caller tools are not strict: their parameters go out as declared and optional
arguments stay optional, so the model can leave out one it has no value for. On the
Responses API (used for caller tools under reasoning, see [Multi-Provider Setup](#multi-provider-setup)) each tool is sent with
`strict: false`, because with `strict` omitted OpenAI "will attempt to normalize your schema
into strict mode when possible" and does so by making every property required: an optional
`unit` the user never named came back as `"unit": "celsius"`, which an input schema cannot tell
from a real value. Chat Completions tools are non-strict by default.

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
  // With `tools` present, `.data` is the model's raw text as `{ content: string }` —
  // NOT a schema-validated object. `outputValidation: "none"` (set above, and required
  // during tool rounds) disables output-schema validation, so parse it yourself.
  result.data;
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
`tool_arguments_invalid` observation. A `timeoutMs` passed to `runToolLoop` applies to every
round and to that final request ([Request Timeouts](#request-timeouts)).
A `cache` option is forwarded to every request, so
an agent loop can reuse the cached system prompt and tools across rounds (see
[Prompt caching](#prompt-caching-anthropic--bedrock)).

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

`extract`, `classify` and `retrieve` take a per-call `timeoutMs` like `generate` ([Request Timeouts](#request-timeouts)).

### Classify (Categorization)

```typescript
const labels = await ctx.ai.classify({
  text: "My subscription was charged twice this month",
  labels: ["billing", "technical", "account", "general"],
});
// → ["billing"]
```

From core **0.7.4+** (included in the core 0.8 and 0.9 families), classification supports per-call `provider` and `model`.
See the [packaged agent recipe](../../packages/plumbus-core/instructions/ai-classification.md).

By default, classification uses the configured text provider. Set `provider` to a
registered text provider or a TypeSafe, Laya, or OpenAI Decisions adapter registered
under `decisions.providers`; `model` optionally overrides that provider's model selection.

```typescript
const labels = await ctx.ai.classify({
  text: "My subscription was charged twice this month",
  labels: ["billing", "technical", "account", "general"],
  provider: "typesafe", // registered under decisions.providers
  model: "jev-1.13.0", // optional endpoint-supported model ID
  threshold: 0.5,
});
```

For Laya, use `provider: "laya", model: "auto"` for automatic language routing,
or an explicit checkpoint configured on your server. For OpenAI's Decisions API
(public beta), register `@plumbus/ai-decision-openai` under a decision key such as
`"openai-decisions"` and use `provider: "openai-decisions", model: "gpt-6-luna"`.
For a generative provider, use e.g. `provider: "openai", model: "gpt-6-sol"` and omit
`threshold`; the decision key must differ from that text provider's name.
Model resolution is per-call → `decisions.defaultModel` → adapter default for
decision providers, or per-call → AI `defaultModel` → adapter default for text providers.

Decision providers score each label independently in one request. The result is
every label with probability greater than or equal to `threshold` (default `0.5`),
in input order; it can be empty or contain multiple labels. `threshold` must be
between 0 and 1 and is only supported for decision providers. Native classification
accepts 1–256 nonempty labels and uses the same validation, security, budgets,
cancellation, and accounting as `decide()`, with one `classify` cost record.
See [decision provider registration](decision-providers.md).

### Retrieve (RAG)

```typescript
const docs = await ctx.ai.retrieve({
  query: "How to reset password?",
});
// → [{ content: "...", source: "docs/auth.md", score: 0.94, metadata: {...} }]
```

`retrieve` takes `signal` (aborts the query's embedding request; see [RAG](#ingestion)) and `timeoutMs` like the other calls.

## AI Providers

### Multi-Provider Setup

Plumbus supports multiple AI providers simultaneously. Each prompt can specify which provider to use via `model.provider`; prompts without a provider field use the configured default.

For OpenAI chat completions, Plumbus maps prompt `maxTokens` to the provider-specific request
field expected by the selected model. Older models receive `max_tokens`; newer completion models
such as `gpt-5*` and `o*` receive `max_completion_tokens`. Core 0.7.5+ (included in the core 0.8 and 0.9 families) adds this handling for
`gpt-6*`. Separately, OpenAI `gpt-5.5+` models only accept the API default temperature (`1`), so
Plumbus omits `temperature`
from the request for those models. In core 0.7.5+ (included in the core 0.8 and 0.9 families), GPT-6 models omit `temperature` while
reasoning is active or left at the model default, but retain a configured temperature when
reasoning is explicitly disabled. Earlier `gpt-5` lines (for example `gpt-5.4-mini`) still receive
the configured temperature.

Optional `model.reasoning` is provider-neutral. OpenAI retains Chat Completions
for compatible requests and uses the Responses API when caller tools require
active reasoning, including GPT-5.6 default reasoning (the forced tool of
`structuredOutputTransport: "tool"` moves only on GPT-5.6/GPT-6, see below). Core 0.7.5+ (included in the core 0.8 and 0.9 families) applies the same routing to
GPT-6 default reasoning. Stateless tool rounds request and replay encrypted reasoning items
through provider continuation state.
Anthropic maps disabled/effort/budget to `thinking` and
`output_config.effort`. Adapter-level
incompatibilities fail locally with `AIInvalidRequestError`; model-specific limitations remain
provider errors, except for the models listed below. The adapter uses bounded model-family
detection only for provider-specific transport and parameter compatibility. The same override
can be supplied via `resolveAiOverrides` / `promptOverrides`.

Core 0.7.9 checks GPT-6 reasoning settings that these models reject before sending the request:

| Model | Accepted | Fails locally with `AIInvalidRequestError` |
| --- | --- | --- |
| `gpt-6-sol`, `gpt-6-luna` | disabled (`none`), efforts `low` to `max` | effort `minimal` |
| `gpt-6-astra`, `gpt-6.1-sol` | efforts `low` to `max` | disabled (these models have no `none` effort; use `low`), effort `minimal` |

GPT-6 Astra and GPT-6.1 Sol support tool calls only through the Responses API, which Plumbus
already uses for tool calls with active or default reasoning. Source: [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model).

The models below return HTTP 400 for any `temperature`, `top_p`, or `top_k` other than the
default, whether or not thinking is on (the adapter sends only `temperature`). In core 0.7.9+
Plumbus sends them no `temperature` at all: not its `0.7` default and not one set on a call or
a prompt, as the OpenAI adapter already does for `gpt-5.5` and later.
It also maps `reasoning` onto what each model accepts:

| Model | `{ mode: 'disabled' }` | `{ mode: 'budget' }` |
| --- | --- | --- |
| `claude-sonnet-5-5` | sent as `thinking: { type: "between_tools" }` | fails locally |
| `claude-haiku-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-4-7` | sent as `thinking: { type: "disabled" }` | fails locally |
| `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5` | fails locally: thinking cannot be turned off, so lower the effort instead | fails locally |
| `claude-mythos-preview` | fails locally, as above | sent as before (`thinking: { type: "enabled" }`) |

Local failures are `AIInvalidRequestError` with reason `reasoning_disabled_unsupported` or
`reasoning_budget_unsupported`. Effort mode is unchanged on every model. Claude Sonnet 5.5 rejects
`thinking: { type: "disabled" }`; `between_tools` is Anthropic's replacement that turns off
up-front thinking, and its short progress notes between tool calls come back as thinking blocks
that Plumbus passes back on the next tool round. Opus 5, Sonnet 5.5, and Haiku 5.5 accept
thinking off only at effort `high` or below; disabled reasoning sends no effort, so the model
default applies (`high`, or `medium` on Haiku 5.5). Other Claude models, such as
`claude-sonnet-4-5`, `claude-haiku-4-5`, and `claude-opus-4-6`, get the same requests as before.
Sources: [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking#sampling-parameters),
[Troubleshooting thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting),
[Effort](https://platform.claude.com/docs/en/build-with-claude/effort).

The legacy `model.reasoningEffort` union and runtime behavior are unchanged: only
`low`, `medium`, and `high`, and only the OpenAI adapter consumes it. Anthropic
continues to ignore that legacy property and keeps its existing `temperature: 0.7`
default unless the new `reasoning` property is explicitly configured, except on the models in
the table above, which never get that default.

```typescript
import { createAIService, createOpenAIAdapter, createProviderAdapter } from "@plumbus/core";
import { createBedrockAdapter } from "@plumbus/ai-bedrock";

const service = createAIService({
  providers: {
    openai: createProviderAdapter("openai", { apiKey: "sk-..." }),
    anthropic: createProviderAdapter("anthropic", { apiKey: "ant-..." }),
    bedrock: createBedrockAdapter({ region: "us-east-1" }),
    // OpenAI-compatible endpoints (Ollama, Azure, …): use createOpenAIAdapter with baseUrl
    ollama: createOpenAIAdapter({
      apiKey: "ollama",
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

`extract()` uses the default provider. `classify()` also uses it unless the call
specifies `provider`; decision adapters are selected from `decisions.providers`.

### Configuration and model resolution

`loadConfig()` reads AI settings from environment variables when building `config/app.config.ts`:

| Variable | Purpose |
|----------|---------|
| `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` | Single-provider mode |
| `AI_DEFAULT_PROVIDER` | Multi-provider default (`openai`, `anthropic`, `bedrock` via env) |
| `AI_OPENAI_*` / `AI_ANTHROPIC_*` | Per-provider API keys, base URLs, and default models |
| `AI_BEDROCK_REGION` / `AI_BEDROCK_MODEL` / `AI_BEDROCK_PRICING_FILE` | Bedrock (IAM auth; optional mounted pricing JSON — recommended in containers) |
| `AI_DEFAULT_MODEL` | Global model fallback for all prompts |
| `AI_PROMPT_CACHE` | Default prompt caching for Anthropic / Bedrock: `true`, `false`, or sections such as `system,tools,messages` (see [Prompt caching](#prompt-caching-anthropic--bedrock)) |
| `PROMPT_{NAME}_{FIELD}` | Per-prompt overrides (`PROVIDER`, `MODEL`, `TEMPERATURE`, `MAX_TOKENS`, `TIMEOUT_MS`; dots → underscores, uppercased), applied by the HTTP server and the worker pool alike |

Env discovery supports `AI_OPENAI_*`, `AI_ANTHROPIC_*`, and `AI_BEDROCK_*`. Other `AI_{NAME}_API_KEY` values log a warning and are ignored — wire custom providers programmatically through `createAIService`. Bedrock requires `pnpm add @plumbus/ai-bedrock`.

A present-but-empty OpenAI or Anthropic API-key slot is treated as unset: the slot is skipped so a leftover blank dotenv line does not crash worker boot. If that provider is the default, set a real key.

The numeric `PROMPT_{NAME}_*` fields are checked when the config loads: `TEMPERATURE` must be a number from 0 to 2, `MAX_TOKENS` a whole number of at least 1, and `TIMEOUT_MS` a whole number of milliseconds from 1 to 2 147 483 647. Anything else (`abc`, `0`, `4k`, `15m`) makes `loadConfig()` throw an error naming the variable, e.g. `Invalid PROMPT_WRITER_MAX_TOKENS="4k": expected a whole number of tokens, at least 1`; a blank value is no override. Earlier releases read such values with `parseInt`/`parseFloat`, so `15m` became 15 ms and `abc` became `NaN`, and the mistake only showed on every call to that prompt.

The provider limits are checked the same way, for each provider slot that is configured (`AI_` in single-provider mode, `AI_OPENAI_`, `AI_ANTHROPIC_`, `AI_BEDROCK_`): `REQUEST_TIMEOUT` must be a whole number of milliseconds from 1 to 2 147 483 647, `MAX_TOKENS` a whole number of tokens (0 or more), `DAILY_COST_LIMIT` a number of US dollars (0 or more, decimals allowed, e.g. `10.5`), and `AI_BEDROCK_PRICING_TTL_MS` a whole number of milliseconds (0 or more). Write plain numbers: there are no unit suffixes. `abc`, `15m`, `4k`, `$50` or `1e3` make `loadConfig()` throw, e.g. `Invalid AI_OPENAI_REQUEST_TIMEOUT="15m": expected a whole number of milliseconds from 1 to 2147483647`; a blank value is unset. Earlier releases read them with `parseInt`/`parseFloat`: `15m` became a 15 ms timeout, and `abc` failed every call later.

When an adapter returns `cost` on `ProviderResponse` / stream `done` (Bedrock), `createAIService` uses that value instead of the hardcoded OpenAI/Anthropic `MODEL_PRICING` catalog.

**Resolution order** for each call, field by field (`provider`, `model`, `temperature`, `maxTokens`, `reasoning`, `timeoutMs`): the per-call value (`provider`, `model`, `reasoning`, `timeoutMs` on `generate` / `generateWithUsage` / `streamGenerate`) → the `resolveAiOverrides` hook's `promptOverrides` (from `app/server.ts`) → the per-prompt env vars (`PROMPT_{NAME}_*`) → the prompt's `model` fields → the defaults (the hook's `defaultModel` / `defaultProvider`, else `AI_DEFAULT_MODEL` / `AI_DEFAULT_PROVIDER`). A layer only decides the fields it sets: a hook answer of `{ model: "gpt-4.1-mini" }` for a prompt keeps that prompt's `PROMPT_{NAME}_MAX_TOKENS` and `PROMPT_{NAME}_TIMEOUT_MS`. So when an override changes the provider, set the model with it. `reasoning` and the deprecated `reasoningEffort` count as one field: the highest layer that sets either decides both (an override's `reasoningEffort` replaces the prompt's `reasoning`). Key the hook's `promptOverrides` by the prompt's name (`report.summarize`) or by its env-style key (`report_summarize`, lower case, dots → underscores); when both are present, the entry under the name wins. The hook is called before each call and its answer replaces the previous one, so an override it stops returning no longer applies. Earlier releases replaced the prompt's whole env entry with the hook's entry (dropping its env `TIMEOUT_MS` and `MAX_TOKENS`), let an env override beat a hook entry keyed by the prompt's name, kept an override after the hook stopped returning it, and ignored the hook's `defaultProvider`.

Hardcoding `model.provider` and `model.name` in `definePrompt()` is valid when you want the contract to pin a model; omit them when you prefer env-driven resolution.

### Amazon Bedrock (`@plumbus/ai-bedrock`)

> **Full guide:** [Amazon Bedrock (`docs/ai/bedrock.md`)](./bedrock.md) — Runtime vs Mantle, env, IAM, tools/streaming, pricing, k8s, production checklist.

Bedrock is an **optional add-on package**, not part of `@plumbus/core`. Apps that never use Bedrock never install the AWS SDK.

#### Why a separate package (not in core)

| Provider | Lives in | HTTP / SDK | Auth | Cost USD source |
|----------|----------|------------|------|-----------------|
| OpenAI | `@plumbus/core` | `fetch` to OpenAI HTTP API | API key | Core `MODEL_PRICING` catalog |
| Anthropic | `@plumbus/core` | `fetch` to Anthropic HTTP API | API key | Core `MODEL_PRICING` catalog |
| **Bedrock** | **`@plumbus/ai-bedrock`** | **`@aws-sdk/client-bedrock-runtime`** | **IAM / IRSA** (default chain; SDK may also use `AWS_BEARER_TOKEN_BEDROCK`) | **Package-owned rates** (AWS Price List or mounted file) |

OpenAI and Anthropic adapters are lightweight HTTP clients. Bedrock needs the AWS SDK (credential chain, SigV4, Converse / InvokeModel shapes). Pulling that into core would:

- Force every Plumbus app to depend on AWS SDK packages even when they only use OpenAI/Anthropic
- Couple core releases to AWS SDK churn
- Blur the boundary between “framework runtime” and “cloud vendor adapter”

So the split matches other optional peers (`@plumbus/mcp`, `@plumbus/api`, `@plumbus/auth`, voice providers): **install only when you need it**.

```
@plumbus/core                          @plumbus/ai-bedrock
─────────────                          ───────────────────
createAIService                        createBedrockAdapter
createProviderAdapter('openai'|…)      BedrockRuntimeClient (AWS SDK)
createProviderAdapter('bedrock') ──►   Converse / ConverseStream / InvokeModel
  (dynamic createRequire)              Price List fetch OR pricing file
Optional ProviderResponse.cost ◄────── sets cost from usage × rates
MODEL_PRICING (OpenAI/Anthropic only)
```

Core’s optional peer: `"@plumbus/ai-bedrock": ">=0.4.0-beta.0 <0.5.0"` in the core 0.9 beta family (`"0.3.x"` in the stable 0.8 family). The add-on’s required peer: `"@plumbus/core": ">=0.9.0-beta.0 <0.10.0"` (stable: `"0.8.x"`; copy literals — see `packages/plumbus-core/instructions/peer-dependencies.md`). **Runtime floor:** `@plumbus/core` **≥ 0.7.0**; prompt caching through `ctx.ai` needs core **≥ 0.7.9** (earlier cores never pass `cache` to the adapter) and `@plumbus/ai-bedrock` **≥ 0.2.2**.

#### Install and wire

```bash
pnpm add @plumbus/ai-bedrock
```

```bash
AI_DEFAULT_PROVIDER=bedrock
AI_BEDROCK_REGION=us-east-1
AI_BEDROCK_MODEL=anthropic.claude-sonnet-4-5-20250929-v1:0
# Recommended in Kubernetes — mount a normalized pricing JSON:
# AI_BEDROCK_PRICING_FILE=/config/bedrock-pricing.json
```

Or programmatically:

```typescript
import { createAIService } from "@plumbus/core";
import { createBedrockAdapter } from "@plumbus/ai-bedrock";

createAIService({
  defaultProvider: "bedrock",
  providers: {
    bedrock: createBedrockAdapter({
      region: "us-east-1",
      pricingFilePath: process.env.AI_BEDROCK_PRICING_FILE,
    }),
  },
});
```

`createProviderAdapter('bedrock', …)` in core dynamically loads `@plumbus/ai-bedrock` and prints `pnpm add @plumbus/ai-bedrock` if it is missing.

**Inference:** Converse / ConverseStream (chat) and InvokeModel (default Titan Text Embeddings V2).  
**Auth:** AWS default credential chain (env keys, shared config, IRSA, instance role) — there is no `AI_BEDROCK_API_KEY`.  
**Prompts:** same `ctx.ai` / `definePrompt` surface; set `model.provider: 'bedrock'` and a **Bedrock model id** (e.g. `anthropic.claude-sonnet-4-5-20250929-v1:0`), not Anthropic Messages API short names alone.

#### Pricing (Bedrock ≠ Anthropic catalog)

Bedrock Runtime responses include **token usage only** — never USD. Cost recording therefore cannot reuse core’s OpenAI/Anthropic `MODEL_PRICING` table (and must not alias Claude-on-Bedrock to Anthropic API rows — regional rates diverge; e.g. Haiku 4.5 on Bedrock us-east-1 is typically **$1.10**/MTok input vs ~$1.00 on the Anthropic API).

Flow:

1. Adapter receives usage from Converse / stream `done`.
2. `@plumbus/ai-bedrock` looks up rates for the model **family key** (strips `us.` / `eu.` prefixes and dated `-YYYYMMDD-vN:M` suffixes).
3. Sets `cost` on `ProviderResponse` / stream `done`.
4. `createAIService` **prefers** that `cost` over `calculateModelCost()`.

| Mode | How rates load | When to use |
|------|----------------|-------------|
| **Pricing file** (`AI_BEDROCK_PRICING_FILE` / `pricingFilePath`) | Mount normalized JSON; **no** Price List fetch | Kubernetes / locked NetworkPolicy — **recommended** |
| **Auto-download** (default when no file) | Fetch AWS Price List for `AI_BEDROCK_REGION`; memory TTL ~24h | Local dev / clusters with CDN egress |

Price List is **public HTTPS** (no IAM). Host stays `pricing.us-east-1.amazonaws.com`; the path `{region}` is your Bedrock region:

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/{region}/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/{region}/index.json
```

Examples for `us-east-1`:

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json
```

**Normalized file (v1)** — small enough for a ConfigMap; generate in CI with `parseAwsOfferRates` from the package (curl both indexes → parse → write JSON):

```json
{
  "version": 1,
  "region": "us-east-1",
  "models": {
    "anthropic.claude-haiku-4-5": {
      "inputPerMTok": 1.1,
      "outputPerMTok": 5.5,
      "kind": "text"
    },
    "amazon.titan-embed-text-v2": {
      "inputPerMTok": 0.02,
      "outputPerMTok": 0,
      "kind": "embedding"
    }
  }
}
```

Parser keeps regional on-demand input/output only (skips Global, batch, latency-optimized, provisioned). Rates are normalized to **USD per 1M tokens**. Unknown models → `cost` `$0` (inference still works). Auto-download failure → `console.warn`, costs stay `$0` until refresh succeeds.

Full curl, one-shot normalize script, ConfigMap sketch, and troubleshooting: [`packages/ai-bedrock/instructions/pricing.md`](../../packages/ai-bedrock/instructions/pricing.md) (in apps: `node_modules/@plumbus/ai-bedrock/instructions/pricing.md`). Package boundary and IAM: [`packages/ai-bedrock/instructions/framework.md`](../../packages/ai-bedrock/instructions/framework.md).

#### What stays the same for app code

Business logic still uses `definePrompt`, `ctx.ai.generateWithUsage`, chat, and RAG. You do **not** call the Bedrock SDK from app code — only register the adapter (env discovery or `createBedrockAdapter`).

**Live smoke (monorepo):** [`examples/ai-bedrock-smoke`](../../examples/ai-bedrock-smoke) — real calls against temporary credentials you put in a local `.env` (never commit it).

**Two AWS surfaces (do not confuse them):**

| Surface | Auth | Plumbus entry | Smoke mode |
|---------|------|---------------|------------|
| Bedrock Runtime (Converse / InvokeModel) | IAM / IRSA | `@plumbus/ai-bedrock` → `createBedrockAdapter` | `runtime` |
| Bedrock Mantle (OpenAI-compatible `bedrock-mantle.*.api.aws`) | Console `OPENAI_API_KEY` + `OPENAI_BASE_URL` | `@plumbus/core` → `createOpenAIAdapter` | `mantle` |

A console export that sets `OPENAI_API_KEY=bedrock-api-key-…` and `OPENAI_BASE_URL=https://bedrock-mantle.<region>.api.aws/v1` is **Mantle**, not `@plumbus/ai-bedrock`.

### Transient Provider Failures

Plumbus automatically retries transient upstream provider responses for AI requests. OpenAI-compatible and Anthropic adapters retry status codes `408`, `429`, `500`, `502`, `503`, and `504` with short exponential backoff before failing the request.

If those retries are exhausted, the capability returns a retryable internal error with HTTP status `503` so clients can tell the user the AI provider is temporarily unavailable and invite them to try again.

### Request Timeouts

Every provider request has a timeout, from sending it to the last byte of the answer — a streamed answer included. It applies to each HTTP attempt: every validation retry, every retried `408`/`429`/`5xx` answer and the non-streaming fallback of `streamGenerate` get their own. The first one set wins:

1. the call: `timeoutMs` on `generate`, `generateWithUsage`, `streamGenerate`, `extract`, `classify`, `retrieve` or `runToolLoop` (every round of the loop and its final request), `timeoutMs` on a RAG pipeline's `ingest` or `retrieve` (each embedding request), or `timeout` on an adapter's `embed()`;
2. the prompt at runtime: `timeoutMs` from the `resolveAiOverrides` hook's `promptOverrides`, else `PROMPT_{NAME}_TIMEOUT_MS` (the HTTP server and the worker pool both apply them; a hook override that does not set `timeoutMs` keeps the env one — see [Configuration and model resolution](#configuration-and-model-resolution));
3. the prompt definition: `model.timeoutMs`;
4. the provider: the adapter's `requestTimeout` (`AI_OPENAI_REQUEST_TIMEOUT`, `AI_ANTHROPIC_REQUEST_TIMEOUT`, `AI_BEDROCK_REQUEST_TIMEOUT`, or `AI_REQUEST_TIMEOUT` in single-provider mode), default 120 000 ms.

```typescript
// A long structured answer with reasoning: give it fifteen minutes.
export const draftReport = definePrompt({
  name: "report.draftSections",
  input: draftInput,
  output: sectionsOutput,
  model: { maxTokens: 64_000, reasoning: { mode: "effort", effort: "high" }, timeoutMs: 900_000 },
});

// A prompt that must answer fast, or not at all, for this call:
await ctx.ai.generateWithUsage({ prompt: "support.classify", input, timeoutMs: 15_000 });
```

`extract`, `classify`, `retrieve` and embeddings have no prompt, so steps 2 and 3 do not apply to them. `classify` with a decision provider (`decisions.providers`) passes `timeoutMs` to that provider as its own `timeoutMs`, which allows at most 300 000 ms.

A timeout is a whole number of milliseconds from 1 to 2 147 483 647. `definePrompt` rejects other values. `loadConfig()` rejects a `PROMPT_{NAME}_TIMEOUT_MS` that is not a plain whole number in that range — `abc`, `0`, `-5`, `15m` — by throwing `Invalid PROMPT_{NAME}_TIMEOUT_MS="15m": expected a whole number of milliseconds from 1 to 2147483647`, so `plumbus dev`, `start` and `worker` stop at startup instead of failing every call later (see [Configuration and model resolution](#configuration-and-model-resolution)). A per-call or `resolveAiOverrides` value outside that range fails with `AIInvalidRequestError` (`reason: "timeout_invalid"`) before anything is sent; so does one given to a RAG pipeline's `ingest`/`retrieve` (checked by the pipeline, whatever the adapter), an adapter's `timeout`, or a built-in adapter's `requestTimeout` (the OpenAI and Anthropic adapters and `@plumbus/ai-bedrock` check it before sending each completion or embedding request).

**Timeouts above five minutes.** A non-streamed answer only arrives once the model has finished, and Node's `fetch` (undici) stops waiting by itself after 300 s without response headers, or without the next body chunk (its `headersTimeout` / `bodyTimeout`). The built-in OpenAI and Anthropic adapters set both limits one second above the request's timeout on every request, through the process's own dispatcher, so the request's timeout always ends it first and a proxy or agent installed with undici's `setGlobalDispatcher` still applies. (The margin matters: undici runs these limits on a coarse timer that can fire up to half a second early.) Earlier releases failed such a request at 300 s with `TypeError: fetch failed` (`UND_ERR_HEADERS_TIMEOUT`), whatever `requestTimeout` allowed. Bedrock's AWS SDK client has no response timeout of its own.

**When the timeout ends a request**, the call fails with a `ProviderAPIError` (`name: "ProviderAPIError"`) that carries `timeoutMs` (the limit reached), `retryable: false` and no `statusCode`, with a message such as `OpenAI API request timed out after 900000 ms` (`OpenAI Responses API`, `OpenAI Embedding API`, `Anthropic API`, `Bedrock`). The adapter does not retry it, and callers should not either: the provider may have billed the work, and asking again with the same limit usually ends the same way — raise the prompt's `timeoutMs` instead. In a capability it surfaces like other non-retryable failures (`Capability execution failed`), not as the retryable `503` above. A `streamGenerate` call cut off mid-stream throws it after the deltas already yielded (Bedrock, which reports every stream failure as an event, ends with an `error` event instead); one cut off before the first byte ends with an `error` event carrying its message. The ledger row is `status: "failed"` with `cost: null` and an `estimatedCost` (see [Failed calls and unknown cost](#failed-calls-and-unknown-cost)). The caller's `signal` stays separate: an abort it raises is rethrown as raised, and when both fire, the first decides.

**Telling a timeout apart.** `@plumbus/core` exports `ProviderAPIError` and two guards. `isProviderAPIError(error)` is true for any provider HTTP failure (`providerName`, `retryable`, `attempts`, and `statusCode` when the provider answered); `isProviderTimeoutError(error)` is true only when the request's own timeout ended it, and narrows `timeoutMs` to a number. Use the guards rather than `instanceof ProviderAPIError`: `@plumbus/ai-bedrock` builds its errors with the same shape, not as instances.

```typescript
import { isProviderTimeoutError } from "@plumbus/core";

try {
  return await ctx.ai.generateWithUsage({ prompt: "report.draftSections", input });
} catch (error) {
  if (isProviderTimeoutError(error)) {
    // Not retryable with the same limit: raise the prompt's timeoutMs instead.
    ctx.logger.warn("draft timed out", { provider: error.providerName, timeoutMs: error.timeoutMs });
  }
  throw error;
}
```

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

Custom OpenAI-compatible providers use `createOpenAIAdapter` explicitly:

```typescript
import { createOpenAIAdapter } from "@plumbus/core";

const ollama = createOpenAIAdapter({
  apiKey: "ollama",
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
| Custom OpenAI-compatible                         | Everything  | Catalog matches **+ all unknowns**    |

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
- OpenAI strict mode cannot leave a property out, so every OpenAI structured-output path (`response_format`, the `structuredOutputTransport: "tool"` function, and Responses `text.format`) sends each optional property as required and nullable: `["string", "null"]` for scalars, an extra `{ "type": "null" }` branch for enums, objects, arrays and unions. Nested objects, array items and union branches are converted the same way. Before the prompt's Zod schema validates the answer, the AI service turns a `null` in an optional property back into an absent property (so `.default()` applies); a `.nullable()` or `.nullish()` property keeps its `null`. `streamGenerate` `delta` events carry OpenAI's raw text, so they still contain those nulls; the final `done` data does not.
- OpenAI strict mode accepts only the string formats `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `ipv4`, `ipv6` and `uuid` ([Structured Outputs, supported properties](https://developers.openai.com/api/docs/guides/structured-outputs)); any other format fails the whole request (`'uri' is not a valid format`). On every OpenAI structured-output path Plumbus leaves such a format out of the sent schema and names it in the property's description instead (`"Expected string format: uri."`), so `z.string().url()` fields work. The prompt's Zod schema still validates the answer, so a value that is not a URL fails validation and is retried as usual. Anthropic and Bedrock receive the `uri` format as before.
- OpenAI strict mode does not support `allOf` (Structured Outputs guide: "Composition: allOf, not, … are not yet supported"), which the converter produces for intersections (`a.and(b)`) and for a string with more than one pattern (`.regex(a).regex(b)`, `.startsWith(a).endsWith(b)`). An intersection of objects is already merged by the converter for every provider (see the converter bullet below), and `z.string().cidr()` arrives as an `anyOf` of its IPv4 and IPv6 patterns. Any `allOf` left is merged into one schema on every OpenAI structured-output path: types and enums are intersected, one union inside another is spread into the branches of both, and keywords next to a union go into each branch. What one schema cannot say is named in the description: every pattern of a string with several (`"Must match pattern: …."`), or the second of two different patterns or formats a shared property has. The prompt's Zod schema still validates the original.
- OpenAI strict mode has no `default` keyword. On every OpenAI structured-output path a `.default(…)` is named in the description instead (`"Defaults to \"untitled\"."`); the property is optional, so it goes out nullable like any other optional property, its `null` is dropped before validation, and Zod fills in the default. Anthropic and Bedrock receive `default` as it is (Anthropic documents it).
- OpenAI strict mode needs an object at the root ("Root objects must not be anyOf and must be an object"). An output whose root is something else — `classify()` (an array of labels), an `extract()` schema or prompt `output` that is a `z.array(...)`, a union or discriminated union, an enum, a number, a nullable object — goes out on OpenAI as the single required property `value` of an object, and the adapter takes the answer out of `{"value": …}` before anything else sees it: the AI service, `ProviderResponse.content`, and `streamGenerate` `delta` events (a stream holds back only the envelope's opening `{"value":`) all carry the bare answer, as on Anthropic, and so does the `partialText` of an `AIIncompleteOutputError` when the answer is cut off at `maxTokens`. An intersection of objects is merged into an object first, so it is not wrapped.
- Anthropic receives `output_config.format: { type: "json_schema", schema: ... }`, with optional properties left optional (its limit of 24 optional properties still applies).
- The converter (`zodToProviderJsonSchema`, the schema Anthropic and `@plumbus/ai-bedrock` `structuredOutputs: "native"` receive as it is) keeps to the subset both document (Anthropic "JSON Schema limitations", Bedrock "Supported JSON Schema features"), and OpenAI's strict projection starts from it. Neither asks for an object root, so an array, union or enum output goes to them unwrapped. Where zod-to-json-schema emits something outside that subset, or something no answer satisfies, the converter rewrites it for every provider; the prompt's Zod schema still validates the original:
  - An intersection of objects (`a.and(b)`) becomes one object with the properties and `required` keys of both (a property both declare gets the merge of its two schemas); an object intersected with a union (`z.object({...}).and(z.discriminatedUnion(...))`) goes into each branch. A branch the intersection rules out is dropped rather than sent: the absent value of `b.optional()` and the `null` of `b.nullable()` (so `a.and(b.optional())` and `a.and(b.nullable())` go out as the one object `a & b`), and, for two discriminated unions on the same key, the pairs whose discriminators differ. Sent as `allOf`, each member carried `additionalProperties: false` and refused the other member's keys, so no answer could satisfy it on a provider that reads the schema strictly.
  - `z.string().cidr()` goes out as an `anyOf` of its IPv4 and IPv6 patterns. zod-to-json-schema lists them in `allOf` (both required), and the IPv4 pattern was only described, so providers allowed IPv6 networks alone.
  - A non-capturing group `(?:…)` in a pattern goes out as a plain group `(…)`, which matches the same strings (patterns with a backreference are still only described).
  - A `.optional()` that is not an object property (the output root, an array item, a union member) loses its never-matching `{ "not": {} }` branch: an optional object output goes out as the object. `not` is in no provider's documented subset.
  - A keyword next to a union (the `type` of `z.string().ip()`) goes into each branch, and a string's `type` into each member of the `allOf` that lists its patterns (`.regex(a).regex(b)`, `.cidr().startsWith(…)`), so every branch and member is a whole schema with a `type`, the shape Anthropic's SDK helpers send.
  - A tuple (`z.tuple([...])`, sent as `prefixItems`, which no provider documents) goes out as an array whose `items` is its item schemas (an `anyOf` when they differ, counted as one union parameter), with the order and length in the description (`"Must hold exactly 2 items, in this order: (1) string; (2) number."`).
- Single-string-field outputs such as `z.object({ content: z.string() })` **and bare `z.string()` outputs** stay in plain text mode for `generate` / `streamGenerate` and are not constrained.
- Prompts can opt out with `disableStrictStructuredOutputs: true` when their schema cannot fit the provider JSON Schema subset.
- Prompts can require strict mode with `requireStrictStructuredOutputs: true` — the AI service refuses to run the prompt unless it can send a provider JSON Schema, preventing silent fallback to prompt-only JSON instructions.
- Transport can be switched with `structuredOutputTransport: "tool"` to use strict tool-call arguments instead of `response_format`, for provider/prompt combinations where JSON-schema response content is weak but tool calls are reliable. On OpenAI the forced tool goes to the Responses API only on GPT-5.6 and GPT-6 models with reasoning not disabled (an explicit effort, the legacy `reasoningEffort`, or the model's default reasoning), because their Chat Completions refuse function tools under reasoning (`Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions`). With reasoning disabled, and on every other model (o-series and earlier `gpt-5` lines included, explicit effort or not), it stays on Chat Completions as before, so an OpenAI-compatible `baseUrl` without `/responses` keeps working. The reasoning setting is sent as configured; a `budget` reasoning mode is refused locally with `AIInvalidRequestError`, as for every OpenAI request.

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

Every AI call is metered. Cost resolution:

1. If the adapter returns `cost` on the provider / stream response (**Bedrock** via `@plumbus/ai-bedrock`), that USD value wins.
2. Otherwise `estimateModelCost()` uses the built-in OpenAI/Anthropic `MODEL_PRICING` table.
3. Unknown models (e.g. local Ollama) → no catalog price (`cost: 0, costAvailable: false` in legacy numeric results; `null` in ledger rows); explicitly free providers may report `cost: 0`.

Bedrock APIs never include dollars — only token usage. See [Amazon Bedrock](#amazon-bedrock-plumbusai-bedrock) and `packages/ai-bedrock/instructions/pricing.md` for Price List URLs and the mounted pricing-file recipe.

### Automatic Per-Request Cost

`generateWithUsage()` returns a `cost` field with the dollar amount calculated from actual token usage:

```typescript
const { data, usage, cost } = await ctx.ai.generateWithUsage({
  prompt: "analyzeTicket",
  input: { text: input.body },
});
// cost = 0.00234 (USD)
```

For OpenAI/Anthropic, cost comes from `estimateModelCost()` and the built-in table. The table records **standard-tier** rates only — Batch, Flex, Fast mode, and regional processing uplifts are not modelled. `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.6-sol` (including the `gpt-5.6` alias), `gpt-5.6-terra`, `gpt-5.6-luna`, and the GPT-6 models apply their documented long-context premium above 272K input tokens. Other OpenAI models list no long-context price and use the base rate at any length. GPT-6 and current Anthropic rates were checked on 2026-10-08; the remaining catalog was last synced on 2026-10-01. Run the `update-model-pricing` skill to refresh rates.

The GPT-6 models use these USD rates per million tokens for requests with at most 272,000 input tokens:

| Model | Input | Cached input | Cache writes | Output |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` | $10 | $1 | $12.50 | $50 |
| `gpt-6.1-sol` | $2 | $0.10 | $2.50 | $10 |
| `gpt-6-sol` | $2 | $0.20 | $2.50 | $10 |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.50 |

Above 272,000 input tokens, input/cache rates double and output rates multiply by 1.5 for the **whole request**. Normalized input includes cache reads and writes once. The existing `-YYYYMMDD` pricing fallback also applies to these entries; no additional API aliases are introduced. Their rates are independent of GPT-5.6 Sol's promotional window. GPT-6.1 Sol cache reads cost **0.05x** input. Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

The September 10 refresh adds GPT-6 Astra, GPT-5.6 Cyber, Claude Fable 5.1, and Claude Mythos 5.1. GPT-5.6 Sol uses the bundled $4/$20 input/output rates ($0.40 cached input) before November 22, 2026 UTC, then falls back to its regular $5/$30 rates ($0.50 cached input). Sonnet 5 stays at $2/$10: Anthropic cancelled its planned September increase. Published cache-read rates are also included. Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing). Legacy entries absent from the current pages are retained for compatibility, not treated as newly verified rates.

The [core 0.7.0 changelog](../../packages/plumbus-core/CHANGELOG.md#ai-pricing-and-accounting) lists the exact before/after catalog and cache-read rates, alias behavior, and accounting corrections.

The September 23 Opus update adds `claude-opus-5-5` with these standard USD rates per million tokens:

| Model | Input | Cached input | 5-minute cache writes | Output |
| --- | --- | --- | --- | --- |
| `claude-opus-5-5` | $4 | $0.20 | $5 | $20 |

Opus 5.5 cache reads cost **0.05x** input, rather than the usual 0.1x. Its rates stay flat throughout the 1M-token context window. Opus 5 and 4.5–4.8 retain $5 input / $0.50 cached input / $25 output; legacy Opus 4/4.1 retain $15 / $1.50 / $75. The existing `-YYYYMMDD` pricing fallback also covers Opus 5.5; it does not introduce new API aliases. Sources: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Opus 5.5 model documentation](https://platform.claude.com/docs/en/models/opus-5-5/overview).

The October 8 update adds Claude Sonnet 5.5 and Claude Haiku 5.5:

| Model | Input | Cached input | 5-minute cache writes | Output |
| --- | --- | --- | --- | --- |
| `claude-sonnet-5-5` | $2 | $0.10 | $2.50 | $10 |
| `claude-haiku-5-5`, prompts up to 100,000 tokens | $0.10 | $0.01 | $0.125 | $0.50 |
| `claude-haiku-5-5`, prompts over 100,000 tokens | $0.50 | $0.05 | $0.625 | $2.50 |

Sonnet 5.5 cache reads cost **0.05x** input, and its rates stay flat throughout the 1M-token context window. Haiku 5.5 is priced by prompt length: above 100,000 input tokens (cache reads and writes included) every token in the request uses the higher row, five times the base rates. Sources: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview).

The October 1 catalog sync also adds `gpt-rosalind-research` ($5 input / $0.50 cached input / $25 output per million tokens, billed by OpenAI from October 5, 2026), records GPT-6.1 Sol's $0.10 cache-read rate, and extends the 272K long-context premium to every OpenAI model priced that way. Source: [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

### Cached Token Pricing

When providers return cache information, the framework adjusts pricing automatically:

- **Cached input tokens** (prompt cache hits) use the published model-specific price when available, defaulting to **0.1x** input. Opus 5.5, Sonnet 5.5, and GPT-6.1 Sol use **0.05x**; Fable 5.1 and Mythos 5.1 use **0.025x**; several older OpenAI models use **0.25x** or **0.5x**.
- **Cache write tokens** (new cache entries) are counted inside the input tokens, like cache reads, and priced once: at **1.25x** the base input rate on Claude (five-minute caching; one-hour cache-write pricing is not separately modelled) and on OpenAI GPT-5.6 and later (the pricing page's "Cache writes" column, e.g. `gpt-6-luna` $0.125 per MTok), and at the base input rate on earlier OpenAI models, which OpenAI bills no extra for a cache write ("No additional cache-write charge").
- Standard (non-cached) input tokens are charged at the full base rate

**Request-side marks:** OpenAI caches automatically. For Anthropic and Bedrock Claude, enable `cache` on the call, or set `AI_PROMPT_CACHE` / `createAIService({ cache })`, so Plumbus emits `cache_control` / `cachePoint` — see [Prompt caching](#prompt-caching-anthropic--bedrock). Without those marks, Anthropic responses report zero cached tokens even though pricing fields exist, and Bedrock caching is best effort.

The framework parses cache data from provider responses:
- **OpenAI**: `usage.prompt_tokens_details.cached_tokens` and `cache_write_tokens` (Chat Completions), `usage.input_tokens_details.cached_tokens` and `cache_write_tokens` (Responses API); `cacheWriteTokens` is set only when OpenAI reports the field
- **Anthropic**: `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`
- **Bedrock**: cache token fields on Converse usage (when present); `@plumbus/ai-bedrock` applies the same ~0.1× / 1.25× multipliers against Bedrock rates
### Long Context Premium

The OpenAI models with a long-context rate (listed above) use a strict **greater than 272,000 input tokens** threshold. At exactly 272,000 tokens the base rates still apply; above it, input, cache reads and cache writes cost 2x, and output costs 1.5x, for the full request.

Claude Haiku 5.5 uses the same strict boundary at **100,000 input tokens** but with its published rates instead of the multipliers: above it, input, cache reads, cache writes, and output all cost 5x the base rates for the full request.

For Claude Sonnet 4 and Claude Sonnet 4.5, Anthropic charges a premium when total input exceeds 200K tokens:

- Input rate: **2x** standard
- Output rate: **1.5x** standard

The framework detects this automatically based on the model name and total input token count. Normalized input already includes cache reads/writes, which are counted once when checking the long-context threshold. Thresholds apply per provider request: validation retries and a streaming validation fallback are priced request by request and then added up, so two 60K-token Claude Haiku 5.5 attempts both pay the up-to-100K rates.

### Budget Enforcement

Successful generation (including streaming and validation fallback), extraction, and classification record adapter-supplied USD cost, falling back to catalog estimates for known models. Both stream and fallback usage/cost are included in the final streaming result and ledger row. Explicit zero cost is valid for free/local providers. Unpriced providers record `null` and remain usable without dollar caps; an adapter for a known-free provider can report `cost: 0` to participate in a shared dollar budget.

A fresh budget starts at zero; a zero-dollar cap blocks calls. Token pre-checks estimate input from UTF-8 request bytes divided by four plus the requested output cap, including validation retries. These are estimates, not tokenizer-exact bounds. In-memory budgets are process-local pre-checks, not atomic spend reservations across concurrent workers; persist and coordinate a ledger for a deployment-wide hard cap.

#### Failed calls and unknown cost

A failed call is charged by what it can have cost, and one failure never stops the budget being enforced:

| Failure | Ledger row | What the dollar budget counts |
| --- | --- | --- |
| Never reached the provider: DNS failure (`ENOTFOUND`, `EAI_AGAIN`), refused or timed-out connect (`ECONNREFUSED`, undici's `Connect Timeout Error`), TLS handshake failure, a signal aborted before the call, a budget or concurrency refusal of a retry attempt (a refusal before the first attempt leaves no row). Applies to `streamGenerate` too, where the built-in adapters report these as an opening `error` event | `cost: 0` | nothing |
| Turned away by the provider with a 4xx (bad key, rate limit, invalid or oversized request). 408 and 424 are not included: they can follow work the model already did (Bedrock's model timeout and model error) | `cost: 0` | nothing |
| Usage never came back (the connection dropped after the request was sent, a read timeout or the request's own [timeout](#request-timeouts), a 5xx, a 408 or 424, an unrecognised error), or a stream was cut off before its `done` event | `cost: null`, `estimatedCost` | the estimate: the request's input estimate plus its `maxTokens` (4,096 when the request sets none) at the model's catalog price — never less than the usage or cost a cut-off stream had already reported (Anthropic reports input at the start, output only at the end) — plus the known cost of any attempts the provider did answer |
| Provider answered (validation failure, refusal, truncation) | `cost` from the reported usage | that cost |

Calls keep running while the day's known costs and estimates stay under the limit; past it the refusal is the usual `Daily cost limit reached`. Answered validation attempts are not lost when a later attempt of the same call fails in transit. `estimatedCost` is a budget charge, not a billed amount: `cost` stays `null`, and `getDailyUsage()` reports only known costs (`costAvailable: false`). A custom adapter that reports a failed request as a stream `error` event instead of throwing should set the event's `cause` to the caught error; without it the AI service cannot tell that the request never reached the provider and charges the estimate.

When cost cannot even be estimated, the budget still fails closed, but only for the model whose spend it cannot count. A model with no catalog price whose provider answered without a cost (a local or custom model, a decision provider without pricing) leaves an unpriced row: later calls to that same provider and model are refused with `Cost data unavailable for prior <provider> <model> requests`, while calls to priced models carry on. Checks that cannot name a model (`checkProviderCostBudget()` for voice and media, decisions, governed calls) are refused by unpriced spend on any model. An attempt that dropped in transit on an unpriced model adds only what the provider had reported before the drop and does not block later calls: it is one call's unknown spend, not a reason to stop the rest of the day.

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

### Governed model calls

`ctx.ai.generate` is the existing convenience path. When a host needs review-before-call and fail-closed spend, wire **once** with `createPlumbusRuntime` and call `runtime.invokeGovernedAi`:

1. **Publish** prompt and policy artifacts. The store is digest-addressed and immutable — same bytes republish as the same digest; a later body change for the same id is refused.
2. The **host** supplies the model (`resolveModel`). Credentials stay in the host. An unregistered or substituted pin fails; there is no fallback model.
3. A **human review** must already match the call input **and** the exact pin (provider, model, prompt digest, policy digest). Request that review with `governedReviewSubject(input, pin)`.
4. The **budget** must be known and allowed. `checkGovernedBudget` refuses missing limits, missing estimates, and "cost data unavailable".

```typescript
import {
  checkGovernedBudget,
  createApprovalService,
  createCostTracker,
  createMemoryApprovalStore,
  createMemoryGovernedArtifactStore,
  createPlumbusRuntime,
  governedReviewSubject,
} from "@plumbus/core";

const artifacts = createMemoryGovernedArtifactStore();
const prompt = artifacts.publish({
  kind: "prompt",
  id: "example.summarize",
  body: "Summarize clearly.",
});
const policy = artifacts.publish({
  kind: "policy",
  id: "example.summarize.policy",
  body: "Do not invent facts.",
});
const pin = {
  providerId: "host-provider",
  modelId: "host-model-a",
  promptDigest: prompt.digest,
  policyDigest: policy.digest,
};

const runtime = createPlumbusRuntime({
  artifacts,
  approvals: createApprovalService({ store: createMemoryApprovalStore() }),
  host: {
    resolveModel: async (requested) => hostModels.get(`${requested.providerId}/${requested.modelId}`),
    checkBudget: async (input) =>
      checkGovernedBudget({
        tracker: createCostTracker({ dailyCostLimit: 25 }),
        budget: { dailyCostLimit: 25 },
        tenantId: input.tenantId,
        estimatedCostUsd: input.estimatedCostUsd,
      }),
  },
});

const result = await runtime.invokeGovernedAi({
  capabilityId: "example.summarize",
  definitionVersion: "1",
  input,
  pin,
  prompt: "Summarize this document.",
  estimatedCostUsd: 0.04,
});
```

Approve first with the same subject the hook will hash:

```typescript
await runtime.approvals.requestApproval({
  capabilityId: "example.summarize",
  definitionVersion: "1",
  input: governedReviewSubject(input, pin),
  riskClass: "consequential",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
});
```

The published prompt body is sent as the model `system` text. A blocked call throws `GovernedAiBlockedError` and does **not** invoke `model.complete`.

The same runtime also exposes `invokeCapability`, `startFlow`, `inspectExecution`, `publishEvent`, and `syncTimers` when you pass the existing registry, engine, emitter, and scheduler. See [Execution lifecycle — Host runtime facade](../architecture/execution-lifecycle.md#host-runtime-facade).

Cost records (`AICostRecord`) include:
- `promptName`, `provider`, `model`, `operation` (`"generate" | "extract" | "classify" | "embed" | "transcribe" | "synthesize" | "transport"`)
- `usage` — input/output token counts including `cachedInputTokens` / `cacheWriteTokens`, and `reasoningTokens` when the provider reports them (part of `outputTokens`, not priced again)
- `mediaUsage` — optional voice/media billing units (`audioInputSeconds`, `audioOutputSeconds`, `characters`, `connectionMinutes`, `participantMinutes`)
- `cost` (USD) and `latencyMs`
- `timestamp`, `tenantId`, `actor`
- `estimatedCost?` — set only while `cost` is `null` on a failed call whose usage never came back (or whose stream was cut off): what dollar budgets charge for it (see [Failed calls and unknown cost](#failed-calls-and-unknown-cost)). Not a billed amount.
- `status` — `"success" | "failed" | "refused" | "incomplete"`. Failed rows still represent real provider-side spend and count toward `dailyCostLimit`; a call that never reached the provider, or that it turned away with a 4xx other than 408/424, is recorded at `cost: 0`. Defaults to `"success"` for records created without an explicit status.
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

### Provider admission and trace propagation

Three optional hooks on `ServerConfig` (or `app/server.ts` exports — `plumbus dev` / `start` / `worker` pass them to the request AI service and to the worker pool) wrap every real provider attempt, including validation retries and streams. `createAIService` accepts the same three as `providerConcurrency`, `resolveProviderHeaders` and `onProviderSpan`.

```typescript
// app/server.ts
import type { ServerConfig } from "@plumbus/core";

// Immediate per-scope ceiling shared by every identity-bound AI service. The default
// scope is provider + tenant + costContext.serviceArea; override resolveScope only when
// the host has another non-private package/workload key. Saturation refuses at once —
// a PlumbusError('conflict') with failureCode / reason `ai-provider-concurrency-exhausted`
// and `retryAfterSeconds: 1` — it never queues or hangs.
export const aiProviderConcurrency: NonNullable<ServerConfig['aiProviderConcurrency']> = {
  maxConcurrentCalls: 8,
};

// Trusted propagation headers for each attempt. They reach the adapter as
// `ProviderRequest.transportHeaders`. authorization, proxy-authorization, x-api-key,
// api-key and content-type are reserved and refused.
export const resolveAIProviderHeaders: NonNullable<ServerConfig['resolveAIProviderHeaders']> = (context) =>
  context.correlationId ? { traceparent: `00-${context.correlationId}-${spanId()}-01` } : {};

// Completed client span: provider, operation, tenantId, actor, correlationId, costContext,
// startedAt, durationMs, status ('ok' | 'error'), traceparent, errorType. Best effort —
// a throwing exporter never changes the model-call result.
export const onAIProviderSpan: NonNullable<ServerConfig['onAIProviderSpan']> = async (span) => {
  await exporter.export(span);
};
```

`AIService.withContext({ tenantId, actor, correlationId })` binds the correlation id the hooks see; flow workers bind the persisted flow correlation id automatically, so a host can keep one trace across request → flow → provider. Types: `AIProviderCallContext`, `AIProviderConcurrencyConfig`, `AIProviderOperation`, `AIProviderSpan`.

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

For that historical 0.6.0 release, `@plumbus/voice` `0.3.x` peered on `@plumbus/core` `0.6.x`. `@plumbus/chat`, `@plumbus/knowledge-base`, `@plumbus/browser-extension`, `@plumbus/mcp`, and `@plumbus/api` declare `0.5.x || 0.6.x` and install alongside core **0.6.x**. `@plumbus/chat` **0.1.11+** needs core **≥ 0.6.11** at runtime (tool protocol / `updateWhere`) even though its declared peer was wider. These are historical ranges; current installations use the [stabilization family](../upgrading-stabilization.md).

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

`ingest` and `retrieve` take an optional `timeoutMs` for each embedding request (sent to the adapter as `EmbeddingRequest.timeout`); unset keeps the adapter's `requestTimeout`. A value that is not a whole number of milliseconds from 1 to 2 147 483 647 fails with `AIInvalidRequestError` (`reason: "timeout_invalid"`) before anything is embedded.

They also take an optional `signal` (`AbortSignal`), passed to every embedding request as `EmbeddingRequest.signal`: when it fires, the in-flight embedding request is aborted (the OpenAI adapter aborts its fetch, `@plumbus/ai-bedrock` its `InvokeModel` calls and sends no further text), and the call rejects with the abort. The pipeline also checks it itself, for adapters that ignore it: an already-aborted `retrieve` embeds nothing, a `retrieve` aborted during the embedding does not search the vector store (the embedding's cost is still reported to `onEmbeddingCost`), and an `ingest` embeds no further batch and stores nothing. `ctx.ai.retrieve({ signal })` passes its signal on (inside flow steps it defaults to `ctx.signal`); earlier releases accepted it and dropped it, so a cancelled request still waited for the embedding. A custom adapter's `embed()` should pass `request.signal` to its transport.

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

`createExecutionContext` binds framework AI services to the executing `auth.tenantId` and `auth.userId` for retrieval, budgets, and ledger attribution, using a fresh service rather than mutating shared state. Custom AI service wrappers must preserve `withContext` if they wrap a framework service. Caller-supplied metadata filters cannot override the tenant namespace. The shipped vector store and pipeline both enforce exact tenant matching; a missing tenant retrieves only documents ingested without a tenant, never all tenants. Tag tenant-owned documents at ingest (`tenantId` or CLI `--tenant-id`). No production pgvector search adapter is shipped; custom stores must apply the same predicate before ranking/limiting results, and the pipeline rechecks returned chunks.

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

`generate`, `streamGenerate`, `extract`, and `classify` apply the same configured prompt-security policy before provider calls. Extract/classify expose their source as the `text` input field; classify labels remain application-owned vocabulary. Explainability stores the redacted input, not the original. Redaction is based on registered field classifications, including nested fields, not automatic detection of PII inside arbitrary free text: classify a `text` field for blanket protection or sanitize free text through an application capability before calling AI.

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

Provider accounting rejects negative/nonfinite token usage and invalid budget estimates. Invalid monetary values become unknown cost rather than poisoning totals. `estimateModelCost()` returns undefined for models absent from the pricing catalog; legacy `calculateModelCost()` and generation results retain numeric zero, with results marked `costAvailable: false`; this is distinct from a free adapter's explicit zero. Anthropic stream accounting retains initial input/cache usage through the final output-token event. These checks establish numeric validity, not proof that a custom provider reports honest usage.

Billing/usage API fetches default to a 10-second timeout (`UsageClientConfig.timeoutMs` overrides it), so a stalled billing endpoint does not indefinitely block `syncCosts()`.

A stream that provides neither usage nor price records unknown cost, not zero. RAG `onEmbeddingCost` retains numeric `cost: 0` with `costAvailable: false` when the embedding adapter has no price; callbacks should preserve that distinction when recording a ledger row. Positive sub-microdollar catalog charges retain precision so repeated small paid calls do not appear free.

### Fixed pricing catalog

Prices and the Sol window are static data bundled with the package. GPT-5.6 Sol and its `gpt-5.6` alias (including supported dated names) use:

| Lookup time | Input / MTok | Cached input / MTok | Output / MTok |
| --- | --- | --- | --- |
| Before `2026-11-22T00:00:00.000Z` | $4 | $0.40 | $20 |
| At or after that UTC instant | $5 | $0.50 | $30 |

The same selection drives `findModelRate`, `allKnownModels`, cost estimates, and catalog-derived generation/streaming ledger entries. The decision happens when estimating cost; already-recorded ledger rows keep their original values. Long-context and cache-write multipliers apply to the selected rate. Free/local-provider behavior is unchanged.

[OpenAI's Sol documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol) guarantees special pricing **at least through November 21, 2026**, not a fixed termination time. The November 22 UTC fallback is our accounting policy, not a claim about the provider's final billing cutoff. If the promotion is extended, the static fallback can overestimate cost until the bundled date is manually updated. There are no runtime fetches, polling jobs, or scheduled tasks; a process running across the cutoff switches on its next pricing lookup.

### Numeric cost compatibility

`calculateModelCost()` keeps its published `number` return type and legacy zero for an unknown model. Use `estimateModelCost()` when callers must distinguish missing pricing from explicit free usage. `generateWithUsage().cost` and `runToolLoop().aggregatedCost` also remain numeric; check `costAvailable` / `aggregatedCostAvailable` before treating those totals as fully priced. The RAG embedding-cost callback exposes `costAvailable` with its existing numeric `cost`. Custom ledgers should store null when availability is false. Framework accounting already uses the unknown-aware path internally, so numeric compatibility values never silently bypass its configured dollar budgets.


### Model-supported reasoning controls

`REASONING_EFFORTS` and `ReasoningEffortOption` are public SDK exports covering `none`
plus every provider-neutral level (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
They are the vocabulary of model metadata; a selected option maps onto the `reasoning`
config as `{ mode: 'disabled' }` for `none` or `{ mode: 'effort', effort }` otherwise.
Omitting a value remains distinct from explicitly selecting `none`.

`ProviderModel.reasoningEfforts` describes known official-endpoint model support.
An empty array means unsupported; null or an absent field means unknown. Custom
endpoints are not assumed to have OpenAI's support simply because model names match.
Applications should obtain choices from this metadata, validate the effective model
after inheritance, and never silently clamp a persisted choice.

Profiles follow the [OpenAI model catalog](https://developers.openai.com/api/docs/models),
including [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
Model-list endpoints do not themselves publish reasoning levels; these framework
profiles need maintenance when provider support changes.

## Structured answers with native tools

For `generateWithUsage({ tools, outputValidation: 'prompt', ... })`, the prompt output schema also constrains a final answer. A `tool_calls` result bypasses answer validation. A final result is parsed and validated once, with failure usage recorded; malformed/truncated output is not retried automatically because retries could duplicate tool effects. Omitted validation or explicit `'none'` with tools retains raw `{ content }` behavior. Custom-agent Chat turns request prompt validation so server-only fields can be observed alongside spoken content. See [Chat tools](../chat/tool-calling.md).

The OpenAI adapter forwards the final schema alongside native tools using Chat Completions `response_format` or Responses `text.format`. See the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). Tool-transport structured output remains mutually exclusive with caller tools.
