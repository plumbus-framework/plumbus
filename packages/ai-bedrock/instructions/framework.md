# @plumbus/ai-bedrock — framework boundary

**Exact path in a consumer app:** `node_modules/@plumbus/ai-bedrock/instructions/framework.md`

Index: `node_modules/@plumbus/ai-bedrock/instructions/README.md`  
Pricing pull / k8s: `node_modules/@plumbus/ai-bedrock/instructions/pricing.md`

`@plumbus/ai-bedrock` is the **Amazon Bedrock AI provider** for Plumbus. It implements `AIProviderAdapter` (Converse chat, Titan embeddings, package-owned pricing). It is an **optional peer** of `@plumbus/core` (version-locked **`0.6.x`**).

**`package.json` peer:** `"@plumbus/core": "0.6.x"` — copy literally; see `packages/plumbus-core/instructions/peer-dependencies.md`.

## When to use / when not

| Use this package | Do not use |
|------------------|------------|
| App needs Bedrock **Runtime** Converse via `ctx.ai` / Titan embed via RAG | OpenAI-only or Anthropic Messages API-only stacks |
| AWS IAM / IRSA (or SDK bearer) for Bedrock Runtime | Bedrock **Mantle** OpenAI-compatible URL → use `createOpenAIAdapter` instead |
| You want cost recording from **AWS Bedrock** rates | Expecting dollars inside the Converse response (Bedrock never returns USD) |
| Regional Bedrock model ids (`anthropic.claude-…-v1:0`) | Anthropic API short names alone (`claude-sonnet-4-…`) without Bedrock ids |

## Package boundary

| Concern | Owned by |
|---------|----------|
| `AIProviderAdapter`, `createAIService`, `ctx.ai.*`, ledger hooks | `@plumbus/core` |
| Optional `ProviderResponse.cost` preference | `@plumbus/core` |
| Env discovery `AI_BEDROCK_*`, `createProviderAdapter('bedrock')` | `@plumbus/core` (dynamic `createRequire`) |
| AWS SDK client, Converse / ConverseStream / InvokeModel | `@plumbus/ai-bedrock` |
| Price List fetch, pricing file parse, USD from usage × rates | `@plumbus/ai-bedrock` |
| App prompts / capabilities / chat | Consumer app (`definePrompt`, `defineCapability`, `@plumbus/chat`) |

## Install

```bash
pnpm add @plumbus/ai-bedrock
```

Requires `@plumbus/core` **≥ 0.6.16**. After install on an existing app, refresh agent wiring so coding agents discover these files:

```bash
plumbus init --patch --agent agents-md
plumbus doctor
```

Missing package + `createProviderAdapter('bedrock')` → clear error: run `pnpm add @plumbus/ai-bedrock`.

Core that loads this package must prefer adapter-supplied `cost` (**`@plumbus/core` ≥ 0.6.16**). Older cores ignore package rates and under-report spend; they also lack `createProviderAdapter('bedrock')` / `AI_BEDROCK_*` env discovery.

## Public exports

| Export | Role |
|--------|------|
| `createBedrockAdapter(config)` | Sync factory → `AIProviderAdapter` (`name: 'bedrock'`) |
| `BEDROCK_DEFAULT_EMBEDDING_MODEL` | `amazon.titan-embed-text-v2:0` |
| `BedrockAdapterConfig` | Config type (region, pricing file, TTL, credentials, …) |
| `BedrockPricingFileV1` / `BedrockModelRate` | Normalized pricing file types |
| `parseAwsOfferRates` / `parsePricingFile` / `normalizeBedrockModelId` / `extractModelIdFromOfferAttrs` | CI helpers to build / validate the pricing file (auto-download is best-effort) |
| `createPricingStore` | Advanced / tests |

## Wiring

### Env + bootstrap (same path as OpenAI/Anthropic)

```bash
AI_DEFAULT_PROVIDER=bedrock
AI_BEDROCK_REGION=us-east-1
AI_BEDROCK_MODEL=anthropic.claude-sonnet-4-5-20250929-v1:0
AI_BEDROCK_EMBEDDING_MODEL=amazon.titan-embed-text-v2:0
# containers / k8s (recommended):
AI_BEDROCK_PRICING_FILE=/config/bedrock-pricing.json
# optional:
# AI_BEDROCK_PRICING_TTL_MS=86400000
# AI_BEDROCK_REQUEST_TIMEOUT=120000
```

| Variable | Required | Purpose |
|----------|----------|---------|
| `AI_BEDROCK_REGION` | yes\* | Bedrock Runtime region + Price List path region |
| `AI_BEDROCK_ENABLED` | alt | With `AWS_REGION` / `AWS_DEFAULT_REGION`, enables discovery without `AI_BEDROCK_REGION` |
| `AI_BEDROCK_MODEL` | no | Default chat model id |
| `AI_BEDROCK_EMBEDDING_MODEL` | no | Default embed model (else Titan V2) |
| `AI_BEDROCK_PRICING_FILE` | **yes in k8s** | Absolute path to normalized pricing JSON |
| `AI_BEDROCK_PRICING_TTL_MS` | no | Auto-download cache TTL (default ~24h) |
| `AI_BEDROCK_REQUEST_TIMEOUT` | no | Client timeout ms |
| `AI_BEDROCK_MAX_TOKENS` | no | Core per-request max-tokens guard |
| `AI_BEDROCK_DAILY_COST_LIMIT` | no | Core daily USD cost guard |

\*Discovery enables Bedrock when `AI_BEDROCK_REGION` is set, or `AI_BEDROCK_ENABLED=1`/`true` + `AWS_REGION` / `AWS_DEFAULT_REGION`. There is **no** `AI_BEDROCK_API_KEY` — inference uses the AWS default credential chain (env keys, shared config, IRSA, instance role). Optional `AWS_BEARER_TOKEN_BEDROCK` is honored by the AWS SDK when set. Optional `AI_BEDROCK_MAX_TOKENS` / `AI_BEDROCK_DAILY_COST_LIMIT` are core AI guards (same pattern as OpenAI/Anthropic), not Converse request fields by themselves.

### Programmatic

```typescript
import { createAIService, createOpenAIAdapter } from '@plumbus/core';
import { createBedrockAdapter } from '@plumbus/ai-bedrock';

createAIService({
  defaultProvider: 'bedrock',
  providers: {
    bedrock: createBedrockAdapter({
      region: 'us-east-1',
      pricingFilePath: process.env.AI_BEDROCK_PRICING_FILE,
    }),
    openai: createOpenAIAdapter({ apiKey: process.env.AI_OPENAI_API_KEY ?? '' }),
  },
});
```

`createBedrockAdapter` is **sync**. Pricing warms on first AI call by default (`warmPricingOnCreate`).

### Prompts (unchanged `ctx.ai` API)

```typescript
import { definePrompt } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const classifyTicket = definePrompt({
  name: 'classifyTicket',
  system: 'You classify support tickets.',
  description: 'Classify a support ticket',
  domain: 'support',
  input: z.object({ ticketText: z.string() }),
  output: z.object({
    department: z.enum(['billing', 'technical', 'general']),
    urgency: z.enum(['low', 'medium', 'high']),
  }),
  model: {
    provider: 'bedrock',
    name: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    temperature: 0.2,
    maxTokens: 256,
  },
});
```

```typescript
const { data, usage, provider, cost } = await ctx.ai.generateWithUsage({
  prompt: 'classifyTicket',
  input: { ticketText: input.body },
});
// provider === 'bedrock'
// cost === USD from pricing file or auto-downloaded regional rates
```

Chat (`@plumbus/chat`) and RAG `retrieve` work the same way once the provider is `bedrock` (RAG needs `ragPipeline` wired with this adapter — see below).

### Tool calling

Same core API as OpenAI/Anthropic. Prompt `model.provider` must be `'bedrock'` (or `defaultProvider: 'bedrock'`):

```typescript
import { runToolLoop, zodToProviderJsonSchema, type AITool } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

const tools: AITool[] = [
  {
    name: 'lookupOrder',
    description: 'Look up an order by id',
    parameters: zodToProviderJsonSchema(z.object({ orderId: z.string() })).schema,
  },
];

const { final, aggregatedCost } = await runToolLoop(ctx.ai, {
  prompt: 'assistant.turn',
  input: { userMessage },
  tools,
  execute: async (call) => lookupOrder(call.arguments as { orderId: string }),
});
// final.data — answer after tool rounds
// aggregatedCost — sum of adapter `cost` across Converse rounds
```

**Gotchas:** `toolChoice: 'none'` omits `toolConfig` (Bedrock has no true none); `'auto'` omits just the `toolChoice` field. Only execute `argumentsStatus === 'parsed'`. Full protocol: `node_modules/@plumbus/core/instructions/ai.md`.

### Structured outputs

Default is `structuredOutputs: 'off'` — prompt `output` schemas are enforced by core's validate-and-repair loop, which works on every model. Set `structuredOutputs: 'native'` on `createBedrockAdapter` to forward the schema as Converse `outputConfig.textFormat`. It is opt-in because model support varies and an unsupported model rejects the whole request.

### Embeddings (RAG)

There is **no** `ctx.ai.embed`. Pass this adapter into `createRAGPipeline({ provider })`:

```typescript
import { createRAGPipeline, createInMemoryVectorStore } from '@plumbus/core';
import { createBedrockAdapter } from '@plumbus/ai-bedrock';

const bedrock = createBedrockAdapter({ region: 'us-east-1' });
const ragPipeline = createRAGPipeline({
  provider: bedrock,
  vectorStore: createInMemoryVectorStore(),
  embeddingModel: 'amazon.titan-embed-text-v2:0', // keep ingest + query identical
});
// Pass ragPipeline into createAIService({ …, ragPipeline }) → ctx.ai.retrieve
// Ingest with ragPipeline.ingest(…). `plumbus rag ingest` is OpenAI-oriented today
// (uses ai.apiKey); do not expect it to pick Titan automatically.
```

**Gotchas:** Mantle has no embeddings. Titan must be enabled in-console. Unkeyed chat models still chat but carry **no `cost` field** until the pricing file has a row.

Cohere embedding models (`cohere.*`) are supported too — the adapter sends `{ texts, input_type }` and reads `embeddings[0]`. `input_type` defaults to `search_document` (`embeddingInputType` to override). Titan takes one text per call, so ingests fan out up to `embedConcurrency` (default 4) with output order preserved.

## Auth (IAM)

Inference uses the **AWS default credential chain** (env keys, shared config, IRSA, instance role). Optional `AWS_BEARER_TOKEN_BEDROCK` is honored by the AWS SDK when set. There is no `apiKey` on `createBedrockAdapter`.

**Not this package:** Bedrock Mantle OpenAI-compatible URLs (`bedrock-mantle.*.api.aws` + console `OPENAI_API_KEY`) use core’s `createOpenAIAdapter` — see `docs/ai/bedrock.md`.

Minimal IAM sketch for Runtime (tighten resource ARNs in production). This package calls **Converse**, **ConverseStream**, and **InvokeModel**. Note that AWS documents Converse itself as requiring `bedrock:InvokeModel` — so when narrowing `Resource`, keep `InvokeModel` on the **chat** model ARNs too, not just the embedding model. `InvokeModelWithResponseStream` is unused by the adapter today:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:Converse",
    "bedrock:ConverseStream"
  ],
  "Resource": "*"
}
```

Also ensure the model / inference profile is **enabled** in the Bedrock console for that account/region (Anthropic models may require a use-case form).

Price List downloads do **not** use IAM — only outbound HTTPS to `pricing.us-east-1.amazonaws.com`.

## Model ids

Use **Bedrock** model ids (or inference-profile ids), not Anthropic Messages API short names alone:

- Chat example: `anthropic.claude-sonnet-4-5-20250929-v1:0` or `us.anthropic.claude-…`
- Embed default: `amazon.titan-embed-text-v2:0`

Rate lookup strips geo prefixes (`us.`, `eu.`, …) and dated `-YYYYMMDD-vN:M` suffixes to a family key.

## Pricing (summary)

Full pull URLs, curl, normalize script, and k8s ConfigMap recipe: **[pricing.md](./pricing.md)**.

| Mode | Behavior |
|------|----------|
| `pricingFilePath` / `AI_BEDROCK_PRICING_FILE` set | **Reliable path** — load normalized JSON keyed by family ids; **no** Price List fetch |
| Else (auto-download) | **Best-effort** — fetch offers; key rows via extracted SDK ids + limited generative display inference; unknowns stay `$0` |

**Do not hardcode / expect a forever-complete AWS model catalog in this package.** Put the models you call in the pricing file.

Example Price List URL (us-east-1 FoundationModels):

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json
```

Bedrock does **not** return dollars on chat responses — only token usage. This package multiplies usage × rates and sets `cost` on the adapter response; core prefers that over OpenAI/Anthropic `MODEL_PRICING`.

### IAM vs CDN

| Concern | Need |
|---------|------|
| Converse / InvokeModel | IAM / IRSA / instance role |
| Auto-download Price List | Outbound HTTPS to `pricing.us-east-1.amazonaws.com` (no IAM) |
| Pricing file mode | No pricing CDN egress |

## Capabilities

Declared: `tools`, `streamingTools`, `parallelToolCalls`, `namedToolChoice` (Converse tool-use). Model-dependent limits still apply on the AWS side.

## Troubleshooting (quick)

| Symptom | Likely fix |
|---------|------------|
| Install / load error for `bedrock` | `pnpm add @plumbus/ai-bedrock`; core **≥ 0.6.16** |
| AccessDenied / model not found | IAM + Bedrock console model access for region (Anthropic use-case form) |
| `cost` missing from responses | No rate for that model family — see [pricing.md](./pricing.md). Unkeyed models (Llama, Mistral, newer Nova generations) need a manual pricing-file row. The field is omitted rather than set to `0`, so core falls back to its own catalog instead of recording spend as free |
| Auto-download fails in cluster | Mount `AI_BEDROCK_PRICING_FILE` |
| Mantle `OPENAI_API_KEY` does not work here | Correct — Mantle uses `createOpenAIAdapter`; this package is Runtime + IAM |
| Tools never fire | Model must support Converse tools; check `finishReason === 'tool_calls'` / use `runToolLoop` |
| RAG retrieve fails / dim mismatch | Wire `ragPipeline` with this adapter; same Titan model id for ingest + query |

## Critical rules

1. **Framework-first** — business logic in `definePrompt` / capabilities / `ctx.ai`; never call Bedrock SDK from app code for product features.
2. **Do not** copy Anthropic `MODEL_PRICING` rows for Bedrock — rates diverge (e.g. Haiku 4.5 regional Bedrock ≠ Anthropic API).
3. **Containers:** prefer `AI_BEDROCK_PRICING_FILE` ([pricing.md](./pricing.md)).
4. **Peer literal** is `"0.6.x"` — never `^0.6.0`. Runtime floor **≥ 0.6.16**.
5. Install the package explicitly; core only `createRequire`s it when the provider name is `bedrock`.
6. **Tools** — use `runToolLoop` / `generateWithUsage({ tools })`; never invent a Bedrock-only tool API. `toolChoice: 'none'` omits tools.
7. **Embeddings** — via `createRAGPipeline({ provider: bedrockAdapter })` + `ctx.ai.retrieve` / rag ingest — not Converse, not Mantle.

## Where to look for more

- [pricing.md](./pricing.md) — Price List URLs, generate normalized file, k8s
- [README.md](../README.md) — quick start
- Monorepo concept guide: `docs/ai/bedrock.md` (Runtime vs Mantle, tools/stream, checklist)
- Broader AI stack: `docs/ai/ai-integration.md`
- Core peer rules: `packages/plumbus-core/instructions/peer-dependencies.md`
