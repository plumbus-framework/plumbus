# Amazon Bedrock (`@plumbus/ai-bedrock`)

> Optional AWS SDK add-on for Plumbus AI: **Bedrock Runtime** Converse chat, streaming, tool use, Titan embeddings, and package-owned USD cost.

This page is the detailed integration guide. For the broader AI stack (prompts, RAG, OpenAI/Anthropic, ledger), see [AI Integration](./ai-integration.md). Consumer agent recipes ship inside the package under `node_modules/@plumbus/ai-bedrock/instructions/`.

---

## Table of contents

1. [What this package is (and is not)](#what-this-package-is-and-is-not)
2. [Runtime vs Mantle](#runtime-vs-mantle)
3. [How people use Bedrock — do we match?](#how-people-use-bedrock--do-we-match)
4. [Install and peers](#install-and-peers)
5. [Wire the adapter](#wire-the-adapter)
6. [Environment variables](#environment-variables)
7. [Authentication](#authentication)
8. [Models and IDs](#models-and-ids)
9. [Chat: complete, stream, tools](#chat-complete-stream-tools)
10. [Structured outputs](#structured-outputs)
11. [Embeddings](#embeddings)
12. [Pricing and cost ledger](#pricing-and-cost-ledger)
13. [IAM permissions](#iam-permissions)
14. [Kubernetes / containers](#kubernetes--containers)
15. [Prompts, chat, RAG](#prompts-chat-rag)
16. [Observability and errors](#observability-and-errors)
17. [Testing](#testing)
18. [Gaps and non-goals](#gaps-and-non-goals)
19. [Gotchas (read this)](#gotchas-read-this)
20. [Checklist before production](#checklist-before-production)

---

## What this package is (and is not)

| | |
|---|---|
| **Package** | `@plumbus/ai-bedrock` `0.1.x` |
| **Peer** | `@plumbus/core` `0.6.x` (literal range — copy from `packages/plumbus-core/instructions/peer-dependencies.md`) |
| **Runtime floor** | `@plumbus/core` **≥ 0.6.16** (provider slot, `AI_BEDROCK_*` discovery, adapter `cost`, wiring v13) |
| **SDK** | `@aws-sdk/client-bedrock-runtime` |
| **Plumbus surface** | `AIProviderAdapter` registered as `providers.bedrock` on `createAIService` |
| **Not included** | Bedrock Agents, Knowledge Bases Retrieve API, Guardrails config UI, image generation, Mantle OpenAI proxy |

Apps that never call Bedrock never install the AWS SDK. Core’s optional peer declares `"@plumbus/ai-bedrock": "0.1.x"`; `createProviderAdapter('bedrock')` dynamically loads the package and prints `pnpm add @plumbus/ai-bedrock` when missing.

Business logic still uses `definePrompt`, `ctx.ai.generateWithUsage`, chat, and RAG. App code does **not** import the Bedrock SDK directly — only register the adapter.

---

## Runtime vs Mantle

Amazon exposes two consumer-facing inference surfaces that look similar in the console but are **different products**:

| Surface | Endpoint style | Auth | Plumbus path | Embeddings |
|---------|----------------|------|--------------|------------|
| **Bedrock Runtime** | `bedrock-runtime.<region>.amazonaws.com` — Converse / ConverseStream / InvokeModel | IAM / IRSA / default credential chain (SDK also honors `AWS_BEARER_TOKEN_BEDROCK` when set) | **`@plumbus/ai-bedrock`** → `createBedrockAdapter` | Yes — Titan via InvokeModel |
| **Bedrock Mantle** | `https://bedrock-mantle.<region>.api.aws/v1` — OpenAI-compatible HTTP | Console-exported `OPENAI_API_KEY` + `OPENAI_BASE_URL` | `@plumbus/core` → `createOpenAIAdapter` | Typically **no** |

A console export that sets `OPENAI_API_KEY=bedrock-api-key-…` and `OPENAI_BASE_URL=https://bedrock-mantle.<region>.api.aws/v1` is **Mantle**, not this package. Using Mantle credentials against `createBedrockAdapter` will not work.

Live dual-mode smoke in the monorepo: [`examples/ai-bedrock-smoke`](../../examples/ai-bedrock-smoke).

---

## How people use Bedrock — do we match?

Common production patterns (AWS docs, samples, and industry write-ups):

| Common use case | Plumbus / `@plumbus/ai-bedrock` |
|-----------------|----------------------------------|
| Unified chat via **Converse** (swap models by `modelId`) | Yes — `complete()` → `ConverseCommand` |
| Streaming UIs via **ConverseStream** | Yes — `stream()` → `ConverseStreamCommand` |
| **Tool use** / function calling (`toolConfig`) | Yes on complete and stream; multi-turn `toolResult` history |
| Multi-turn conversation state as messages | Yes — Plumbus `messages` → Bedrock `Message[]` |
| System / developer instructions | Yes — `system` → Converse `system` blocks |
| Token usage + stop reasons | Yes — mapped into Plumbus usage / finishReason |
| **Embeddings** via InvokeModel (not Converse) | Yes — default Titan Text Embeddings V2 |
| Cost / FinOps from Price List (API has no USD) | Yes — package-owned rates + `cost` on responses |
| Guardrails on Converse (`guardrailConfig`) | **Not first-class** — app can wrap or extend later |
| Multimodal image/document blocks | **Not first-class** — text/tool path today |
| Structured outputs / `outputConfig` | Opt-in — `structuredOutputs: 'native'`; default stays on core validate-and-repair |
| Bedrock Agents / KB Retrieve | Out of scope — use RAG in core / knowledge-base |
| Mantle OpenAI proxy | Use OpenAI adapter, not this package |

**Verdict:** We match the mainstream Converse + tools + stream + embed + cost path that most application backends need. Remaining Converse features (guardrails, multimodal, cache checkpoints) are documented gaps, not silent pretenses of support.

---

## Install and peers

```bash
pnpm add @plumbus/ai-bedrock
```

| Dependency | Range | Notes |
|------------|-------|-------|
| `@plumbus/core` (peer) | `0.6.x` (**≥ 0.6.16** at runtime) | Copy literal; never `^0.6.0` |
| Core optional peer on this package | `0.1.x` | Declared in `@plumbus/core` `peerDependencies` / `peerDependenciesMeta` |
| Publish order | ai-bedrock **before** core | See `.github/workflows/publish.yml` |

Refresh agent wiring so consumer agents discover package instructions:

```bash
plumbus init --patch --agent agents-md
plumbus doctor
```

---

## Wire the adapter

### Programmatic

```typescript
import { createAIService } from '@plumbus/core';
import { createBedrockAdapter } from '@plumbus/ai-bedrock';

const ai = createAIService({
  defaultProvider: 'bedrock',
  providers: {
    bedrock: createBedrockAdapter({
      region: 'us-east-1',
      defaultModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      defaultEmbeddingModel: 'amazon.titan-embed-text-v2:0',
      // pricingFilePath: '/config/bedrock-pricing.json',
    }),
  },
});
```

### Factory hint

When env discovery (or `aiProviders` config) includes `bedrock`, bootstrap calls:

```typescript
import { createProviderAdapter } from '@plumbus/core';

const bedrock = createProviderAdapter('bedrock', {
  provider: 'bedrock',
  region: 'us-east-1', // required (or AWS_REGION)
  model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  embeddingModel: 'amazon.titan-embed-text-v2:0',
  pricingFilePath: '/config/bedrock-pricing.json',
  requestTimeout: 120_000,
  pricingCacheTtlMs: 86_400_000,
});
```

That dynamically `require`s `@plumbus/ai-bedrock` and forwards those fields into `createBedrockAdapter`. If the package is missing, core throws: `pnpm add @plumbus/ai-bedrock`.

### `createBedrockAdapter` options

| Option | Required | Description |
|--------|----------|-------------|
| `region` | yes | Bedrock Runtime + Price List region path (e.g. `us-east-1`, `eu-north-1`) |
| `credentials` | no | Explicit AWS credentials or provider; else default chain |
| `defaultModel` | no | Converse model when request omits `model` |
| `defaultEmbeddingModel` | no | Default Titan V2 id |
| `requestTimeout` | no | ms (default `120_000`) |
| `endpoint` | no | VPC / GovCloud Runtime endpoint override |
| `pricingFilePath` | no | Normalized JSON; skips Price List download |
| `pricingCacheTtlMs` | no | In-memory TTL for auto-download (default 24h) |
| `pricingRefreshTimeoutMs` | no | Fetch timeout (default 15s) |
| `structuredOutputs` | no | `'off'` (default) or `'native'` — see [Structured outputs](#structured-outputs) |
| `embedConcurrency` | no | Max parallel InvokeModel embedding calls (default 4) |
| `embeddingInputType` | no | Cohere `input_type` (default `search_document`); ignored by Titan |
| `warmPricingOnCreate` | no | When true (default if no injected `pricingStore`), kick off a background `warm()` at factory time. Methods always `await warm()` before use either way. |
| `runtimeClient` / `pricingStore` | no | Test injection |

---

## Environment variables

Discovered by `@plumbus/core` when `@plumbus/ai-bedrock` is installed and Bedrock is enabled (see below). Then `createProviderAdapter('bedrock', …)` builds the adapter at bootstrap.

| Variable | Required | Purpose |
|----------|----------|---------|
| `AI_DEFAULT_PROVIDER=bedrock` | for multi-provider env load | Prefer Bedrock as default provider |
| `AI_BEDROCK_REGION` | yes\* | Bedrock Runtime region + Price List path region |
| `AI_BEDROCK_ENABLED` | alt\* | `1` / `true` + `AWS_REGION` (or `AWS_DEFAULT_REGION`) enables discovery without `AI_BEDROCK_REGION` |
| `AI_BEDROCK_MODEL` | no | Default Converse model id |
| `AI_BEDROCK_EMBEDDING_MODEL` | no | Default embedding model (else Titan V2) |
| `AI_BEDROCK_PRICING_FILE` | **yes in k8s** | Absolute path to normalized pricing JSON |
| `AI_BEDROCK_PRICING_TTL_MS` | no | Auto-download in-memory TTL (default ~24h) |
| `AI_BEDROCK_REQUEST_TIMEOUT` | no | Adapter request timeout ms (default `120000`) |
| `AI_BEDROCK_MAX_TOKENS` | no | Core per-request max-tokens guard (not a Bedrock SDK field by itself) |
| `AI_BEDROCK_DAILY_COST_LIMIT` | no | Core daily USD cost guard |

\*Bedrock env discovery activates when `AI_BEDROCK_REGION` is set, **or** `AI_BEDROCK_ENABLED=1`/`true` with `AWS_REGION` / `AWS_DEFAULT_REGION`. There is **no** `AI_BEDROCK_API_KEY`.

Standard AWS credential env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` / `AWS_DEFAULT_REGION`, profile, IRSA web identity) apply to the SDK. Optional `AWS_BEARER_TOKEN_BEDROCK` is picked up by the AWS SDK when present.

---

## Authentication

1. **Preferred production:** IRSA / instance role / task role with least-privilege Bedrock Runtime actions.
2. **Local / CI:** temporary access keys or SSO profile via the default chain.
3. **Bearer token:** some console workflows export a Bedrock bearer token; the AWS SDK can use `AWS_BEARER_TOKEN_BEDROCK`. Prefer short-lived credentials and rotate after smoke tests.
4. **Do not** put Mantle `OPENAI_API_KEY` into this adapter — wrong product.

There is no `apiKey` field on `BedrockAdapterConfig`.

---

## Models and IDs

Use **Bedrock model IDs** (and optional cross-region inference profile prefixes), not Anthropic Messages API short names alone.

Examples:

- `anthropic.claude-sonnet-4-5-20250929-v1:0`
- `us.anthropic.claude-haiku-4-5-20251001-v1:0`
- `amazon.nova-lite-v1:0`
- `amazon.titan-embed-text-v2:0`

Pricing lookup **normalizes** IDs to family keys (strips `us.` / `eu.` / … prefixes and dated `-YYYYMMDD-vN:M` suffixes) so rates resolve across inference profiles.

**Model access:** the AWS account must enable each model in the Bedrock console. Anthropic models often require a use-case form; until approved, Converse returns `AccessDeniedException`.

**Cost for less-common models:** auto-download is **best-effort** (extract SDK ids from offer attrs / `usagetype` when present; limited generative inference for Claude / Titan / Nova display shapes). It is **not** a hardcoded forever-catalog of AWS models. In practice most families arrive via ids embedded in `usagetype`, while the marketplace "Bedrock Edition" Claude rows and first-party Titan rows resolve by display name. Anything unkeyed returns **no cost** (field omitted) until you add a row to the mounted pricing file — Llama, Mistral, Qwen, and newer Nova generations are common examples. See [pricing.md](../../packages/ai-bedrock/instructions/pricing.md).

Lookup is tolerant of the two family-key shapes this produces: a request for `amazon.nova-lite-v1:0` resolves against a `amazon.nova-lite-v1` key first and a version-less `amazon.nova-lite` key second.

`listModels()` returns families present in the **pricing store** (file or Price List), filtered by `kind` — it is not a live Bedrock ListFoundationModels control-plane call.

---

## Chat: complete, stream, tools

### Complete

`adapter.complete(request)` → `ConverseCommand`:

- `prompt` or `messages` (+ optional `system`)
- `maxTokens` / `temperature` → `inferenceConfig`
- `tools` / `toolChoice` → `toolConfig` (see below)
- Response: `content`, `toolCalls`, `usage`, `finishReason`, **`cost`**

Stop-reason mapping:

| Bedrock | Plumbus |
|---------|---------|
| `end_turn` / `stop_sequence` | `stop` |
| `tool_use` | `tool_calls` |
| `max_tokens` | `length` |

### Stream

`adapter.stream(request)` → `ConverseStreamCommand` with the **same** `toolConfig` / system / inference fields as complete.

Events: `content_delta`, `usage`, `done` (with `cost` + optional `toolCalls`), `error`.

Tool-use streaming: content-block start/delta/stop accumulate partial JSON tool input; invalid JSON yields `argumentsStatus: 'invalid'`.

### Tools

| Plumbus | Bedrock |
|---------|---------|
| `tools[].name/description/parameters` | `toolSpec` + `inputSchema.json` |
| `toolChoice: 'auto'` (or unset) | field **omitted** — `toolChoice` support is model-dependent on Bedrock and omitting it means the same thing |
| named function choice | `{ tool: { name } }` |
| `toolChoice: 'none'` | **omit** `toolConfig` (Bedrock has no true none) |
| assistant `toolCalls` in history | `toolUse` content blocks |
| role `tool` messages | `toolResult` blocks on a `user` turn — a run of consecutive `tool` messages (parallel calls) is coalesced into **one** user turn, as Converse requires |

Capabilities advertised: `tools`, `streamingTools`, `parallelToolCalls`, `namedToolChoice` (no `parallelToolCallControl`).

---

## Structured outputs

By default (`structuredOutputs: 'off'`) a prompt's `output` schema is enforced by core's validate-and-repair loop — the adapter does not forward `responseSchema` to Bedrock. That works on every model.

Set `structuredOutputs: 'native'` to forward the schema as Converse `outputConfig.textFormat` (`type: 'json_schema'`, schema serialized as a JSON string):

```typescript
createBedrockAdapter({ region: 'us-east-1', structuredOutputs: 'native' });
```

**Opt-in on purpose:** `outputConfig` support is model-dependent, and a model that does not accept it rejects the entire request. Verify against your model before enabling it in a deployment. When a prompt sets `structuredOutputTransport: 'tool'`, the adapter skips `outputConfig` so the response is not double-constrained.

---

## Embeddings

`adapter.embed({ texts, model? })` calls **InvokeModel** per text (default model `amazon.titan-embed-text-v2:0`).

| Model family | Request body | Response field |
|---|---|---|
| Titan (default) | `{ inputText }` | `embedding` |
| Cohere (`cohere.*`) | `{ texts: [text], input_type }` | `embeddings[0]` |

`input_type` defaults to `search_document`; override with `embeddingInputType` (use `search_query` for a query-side adapter). Titan ignores it.

Titan accepts one text per call, so a corpus ingest is N round trips — up to `embedConcurrency` (default 4) run in parallel, and output order always matches `texts`.

Returns `embeddings`, `usage.totalTokens` (sum of `inputTextTokenCount`), and **`cost`** when a rate is known.

App code should not call the adapter directly for product features — wire the same adapter into `createRAGPipeline({ provider })` and use `ctx.ai.retrieve` / `plumbus rag ingest`. Mantle OpenAI mode typically cannot embed.

---

## Pricing and cost ledger

Bedrock Runtime never returns USD — only tokens. Cost recording:

1. Adapter attaches `cost` on complete / stream `done` / embed.
2. `createAIService` **prefers adapter `cost`** over core’s OpenAI/Anthropic `MODEL_PRICING` catalog.
3. Do **not** alias Claude-on-Bedrock to Anthropic API rows (regional rates differ).

### Modes

| Mode | Behavior |
|------|----------|
| `pricingFilePath` / `AI_BEDROCK_PRICING_FILE` | **Production path** — load normalized v1 JSON keyed by family ids; missing/invalid file **throws** on first warm |
| Auto-download | **Best-effort** — HTTPS GET Price List indexes; key via extracted SDK ids + limited generative display inference; failure / unkeyed models → warn + `$0` |

Prefer the pricing file. AWS Price List does not expose a stable Converse `modelId`↔USD join; this package will **not** maintain a forever-growing hardcoded model table.

### Price List URLs (public, no IAM)

Host is always `pricing.us-east-1.amazonaws.com`; `{region}` is your Bedrock region:

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/{region}/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/{region}/index.json
```

Normalize with `parseAwsOfferRates` from this package. Full curl, Node script, ConfigMap sketch: [`packages/ai-bedrock/instructions/pricing.md`](../../packages/ai-bedrock/instructions/pricing.md).

### Cache tokens and Global SKUs

When Converse reports `cacheReadInputTokens` / `cacheWriteInputTokens`, they map to Plumbus `cachedInputTokens` / `cacheWriteTokens`.

Bedrock reports cache tokens **outside** `inputTokens` — per AWS, `total input tokens = inputTokens + cacheReadInputTokens + cacheWriteInputTokens` — so cost adds them on top of `inputTokens` rather than carving them out of it.

Cache rates come from the Price List when available (`cacheReadPerMTok` / `cacheWritePerMTok`), and fall back to approximate multipliers (**0.1×** read, **1.25×** write of the input rate) when a family has no published cache SKU. AWS bills the **1-hour** cache-write tier above the 5-minute one; only the default tier is modelled, so mount explicit rates if you rely on long-TTL caching.

**Global inference profiles:** a `global.`-prefixed model id is priced from the Global SKU (`globalInputPerMTok` / `globalOutputPerMTok`) when present, which AWS bills below the regional rate; `us.` / `eu.` geo profiles keep the regional rate. Without a global row the regional rate is used.

Tiny embedding costs use high decimal precision (`toFixed(10)`) so Titan micro-costs do not round to `$0`.

**Unknown models return no `cost` at all** (the field is omitted, not `0`), so core falls back to `calculateModelCost` instead of recording real spend as free. Ledger rows with no cost mean "no rate for this family" — mount a pricing file.

Price List **Global / cross-region** SKUs are parsed into the separate `globalInputPerMTok` / `globalOutputPerMTok` fields rather than replacing the regional rate, so a `global.`-prefixed call is priced from the Global SKU while regional traffic keeps the regional one. Batch, reserved/provisioned, latency-optimized, priority and flex tiers are still skipped (same “standard tier” policy as core OpenAI/Anthropic).

---

## IAM permissions

Actions this adapter calls (tighten resource ARNs / region as needed):

- `bedrock:InvokeModel` — **required for chat, not just embeddings.** The AWS
  Converse API reference states: *"This operation requires permission for the
  `bedrock:InvokeModel` action."* Do **not** scope this to your embedding model
  ARN only, or Converse returns `AccessDeniedException`.
- `bedrock:Converse` / `bedrock:ConverseStream` — include alongside it.

`bedrock:InvokeModelWithResponseStream` is **not** used by `@plumbus/ai-bedrock` today (chat streaming goes through ConverseStream). You may still include it if other app code invokes models that way.

Price List download does **not** need IAM. Model enablement and Anthropic use-case approval are account/console steps outside IAM policy JSON.

---

## Kubernetes / containers

Recommended pattern:

1. CI job curls both Price List indexes for the deploy region.
2. Normalize to `bedrock-pricing.json` (schema `version: 1`, `models` map).
3. Mount as ConfigMap / volume.
4. Set `AI_BEDROCK_PRICING_FILE=/config/bedrock-pricing.json` (or `pricingFilePath` in code).
5. Grant the workload IRSA role Converse / ConverseStream / InvokeModel only — no Price List egress required at runtime.

Avoid relying on in-pod auto-download in locked-down clusters (no egress to the pricing CDN, cold-start race, replica drift).

---

## Prompts, chat, RAG

### Prompt + generate

```typescript
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

definePrompt({
  name: 'summarizeTicket',
  description: 'Summarize a support ticket',
  domain: 'support',
  input: z.object({ ticketText: z.string() }),
  output: z.object({ summary: z.string() }),
  model: {
    provider: 'bedrock',
    name: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
});

const { data, usage, provider, cost } = await ctx.ai.generateWithUsage({
  prompt: 'summarizeTicket',
  input: { ticketText: input.body },
});
// provider === 'bedrock'
// cost === USD from this package’s rates (not core Anthropic MODEL_PRICING)
```

Chat packages (`@plumbus/chat`) inherit the registered Bedrock adapter when `model.provider: 'bedrock'` (or default provider is bedrock). No Bedrock-specific chat APIs are required. Streaming UIs use `ctx.ai.streamGenerate` → adapter `stream()` → ConverseStream (same tools/system fields as complete).

### Tool calling (same `ctx.ai` surface as OpenAI/Anthropic)

Bedrock Converse maps Plumbus tools → `toolConfig`. Prefer `runToolLoop` over hand-rolling history:

```typescript
import { runToolLoop, zodToProviderJsonSchema, type AITool } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

const lookupOrderInput = z.object({ orderId: z.string() });

const tools: AITool[] = [
  {
    name: 'lookupOrder',
    description: 'Look up an order by id',
    parameters: zodToProviderJsonSchema(lookupOrderInput).schema,
  },
];

// Prompt must use model.provider: 'bedrock' (or defaultProvider === 'bedrock').
const { final, rounds, aggregatedCost } = await runToolLoop(ctx.ai, {
  prompt: 'assistant.turn',
  input: { userMessage },
  tools,
  toolChoice: 'auto',
  execute: async (call) => {
    // Only 'parsed' calls reach execute — never run invalid args.
    return lookupOrder(call.arguments as { orderId: string });
  },
});
// final.data — structured answer
// rounds / aggregatedCost — every Converse round (adapter `cost` summed)
```

Single-round (no loop):

```typescript
const result = await ctx.ai.generateWithUsage({
  prompt: 'assistant.turn',
  input: { userMessage },
  tools,
  toolChoice: 'auto',
  outputValidation: 'none', // usual during tool rounds
});

if (result.finishReason === 'tool_calls') {
  for (const call of result.toolCalls) {
    if (call.argumentsStatus !== 'parsed') continue;
    // …
  }
} else {
  result.data;
}
```

**Bedrock-specific tool gotchas**

- `toolChoice: 'none'` → Plumbus **omits** `toolConfig` (Bedrock has no true none). `runToolLoop` already omits tools on its final exhaustion round — do not force `'none'` yourself expecting Anthropic/OpenAI semantics.
- Not every Bedrock model supports tools; enable a Converse tool-capable id (e.g. Claude / Nova that your account has approved).
- Streamed tool args are accumulated across ConverseStream deltas; invalid JSON → `argumentsStatus: 'invalid'` (never execute those).
- Full tool-protocol typing lives in core: `node_modules/@plumbus/core/instructions/ai.md` (Tool calling).

### Embeddings + RAG

There is **no** `ctx.ai.embed`. Embeddings run through the RAG pipeline’s configured `AIProviderAdapter` (InvokeModel Titan by default on this package):

```typescript
import { createAIService, createRAGPipeline, createInMemoryVectorStore } from '@plumbus/core';
import { createBedrockAdapter } from '@plumbus/ai-bedrock';

const bedrock = createBedrockAdapter({
  region: 'us-east-1',
  // AI_BEDROCK_EMBEDDING_MODEL or:
  defaultEmbeddingModel: 'amazon.titan-embed-text-v2:0',
});

const ragPipeline = createRAGPipeline({
  provider: bedrock, // adapter must implement embed()
  vectorStore: createInMemoryVectorStore(),
  embeddingModel: 'amazon.titan-embed-text-v2:0',
});

const ai = createAIService({
  defaultProvider: 'bedrock',
  providers: { bedrock },
  ragPipeline,
});

// After bootstrap wires this as ctx.ai:
// await ctx.ai.retrieve({ query: 'refund policy' });
// Ingest programmatically: await ragPipeline.ingest({ documentId, content, source, … }).
//
// Note: `plumbus rag ingest` today builds an OpenAI embedding adapter from
// `ai.apiKey` — it does **not** auto-use Bedrock. For Titan embeddings, ingest
// via `ragPipeline.ingest` (or your app bootstrap) with this adapter.
```

**Embedding gotchas**

- Converse does **not** embed — only InvokeModel (this package). Mantle OpenAI mode typically has **no** embeddings.
- Titan V2 default dimensions / body are the SDK defaults (`{ inputText }` only) — keep ingest and query on the **same** model id or vector search breaks.
- `cost` on embed can look like `$0.00000008` for tiny inputs — that is intentional precision, not a bug.
- Enable `amazon.titan-embed-text-v2:0` (or your chosen id) in the Bedrock console for the region.

---

## Observability and errors

| Condition | Behavior |
|-----------|----------|
| `ValidationException` / `AccessDeniedException` | Thrown / streamed as `Bedrock request failed (<Name>): …` |
| Other SDK errors | Re-thrown as Error |
| Empty ConverseStream body | Stream `error` event |
| Mid-stream service exception (throttling, internal, model-stream, validation, unavailable) | ConverseStream models these as **events**, not throws — the adapter emits a stream `error` event and stops; it never reports a truncated answer as a clean `done` |
| Missing embedding vector | Throws |
| Pricing file missing | Throws on warm |
| Price List download fail | Console warn; `cost` omitted (unknown), retried after a 5-minute backoff rather than on every request |

Prefer structured app logging around `ctx.ai` / ledger entries rather than parsing raw SDK exceptions in handlers.

---

## Testing

| Layer | Approach |
|-------|----------|
| Unit | Inject `runtimeClient: { send }` + `pricingStore` / `pricingFilePath` (package vitest suite) |
| Integration | Mount fixture pricing JSON; mock Converse shapes |
| Live | [`examples/ai-bedrock-smoke`](../../examples/ai-bedrock-smoke) — temporary creds in local `.env`, erase after |

Never commit AWS keys. Rotate any credential used for manual smoke.

---

## Gaps and non-goals

Documented so deployers do not assume silent support:

- **Guardrails** — no `guardrailConfig` plumbing yet
- **Multimodal** Converse content blocks (image/document/video)
- **Prompt caching** `cachePoint` blocks — the adapter never *creates* cache checkpoints, it only prices the cache tokens a model reports (Nova caches automatically; Claude needs checkpoints this adapter does not emit yet)
- **1-hour cache-write tier** — priced at the default 5-minute write rate; AWS bills the longer TTL higher
- **Batch / provisioned-throughput / priority / flex** pricing tiers
- **Bedrock Agents**, Flows, Knowledge Bases Retrieve/RetrieveAndGenerate
- **Image / video / audio** generation models
- **First-class Mantle** productization (use OpenAI adapter)
- Control-plane **ListFoundationModels** as `listModels` source

Contributions that stay within the `AIProviderAdapter` contract are welcome; do not call the Bedrock SDK from app business logic.

---

## Gotchas (read this)

| Gotcha | What to do |
|--------|------------|
| Console `OPENAI_API_KEY` + Mantle URL | That is **Mantle** → `createOpenAIAdapter`, not this package |
| Anthropic `AccessDenied` | Enable model + submit Anthropic use-case form in the Bedrock console |
| `cost` missing on ledger rows | No rate for that family (Llama / Mistral / newer Nova generations / anything the parser cannot key) or the Price List download failed — mount a pricing file |
| Pricing file path wrong in k8s | File mode **throws** on first AI call (unlike auto-download which warns) |
| `toolChoice: 'none'` | Omits tools entirely; do not expect OpenAI/Anthropic “none” wire shape |
| Mixing OpenAI embed dims with Titan | RAG will return nonsense — one embedding model for ingest + query |
| Expecting `plumbus rag ingest` to use Titan | CLI path is OpenAI/`ai.apiKey` today — ingest via `ragPipeline.ingest` with the Bedrock adapter |
| Global inference profile on the bill | Call it with the `global.` prefix so the Global SKU is used; without a global row it falls back to the regional rate |
| Peer `0.6.x` but core `< 0.6.16` | No provider slot / no adapter `cost` preference / no wiring v13 |
| Agent never opens these recipes | `plumbus init --patch` then `plumbus doctor` |

---

## Checklist before production

- [ ] `@plumbus/ai-bedrock@0.1.x` installed; peer `@plumbus/core` `0.6.x` satisfied and runtime **≥ 0.6.16** (npm Docker installs verify peers — pnpm alone is insufficient)
- [ ] Adapter registered (env discovery or `createBedrockAdapter`)
- [ ] Correct product path chosen: **Runtime** vs **Mantle**
- [ ] Models enabled in the account (Anthropic forms if needed)
- [ ] IAM: Converse, ConverseStream, InvokeModel
- [ ] Pricing: mounted file **or** intentional Price List egress
- [ ] Prompt / chat / RAG `model.provider: 'bedrock'` with Bedrock model IDs
- [ ] Cost ledger entries show non-zero USD for known traffic (or explain `$0` = missing rates)
- [ ] Smoke run in target region; secrets rotated / `.env` deleted
- [ ] Agent wiring refreshed (`plumbus doctor`) so agents read package `instructions/`

---

## Related links

- Package README: [`packages/ai-bedrock/README.md`](../../packages/ai-bedrock/README.md)
- Agent recipes: [`packages/ai-bedrock/instructions/`](../../packages/ai-bedrock/instructions/) — especially [`pricing.md`](../../packages/ai-bedrock/instructions/pricing.md)
- AI overview: [ai-integration.md](./ai-integration.md)
- Live smoke: [`examples/ai-bedrock-smoke`](../../examples/ai-bedrock-smoke)
- Peer range policy: [`packages/plumbus-core/instructions/peer-dependencies.md`](../../packages/plumbus-core/instructions/peer-dependencies.md)
- Monorepo packages table: [root README — Packages](../../README.md#packages)
