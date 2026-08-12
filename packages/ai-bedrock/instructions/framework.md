# @plumbus/ai-bedrock — framework boundary

**Exact path in a consumer app:** `node_modules/@plumbus/ai-bedrock/instructions/framework.md`

Index: `node_modules/@plumbus/ai-bedrock/instructions/README.md`  
Pricing pull / k8s: `node_modules/@plumbus/ai-bedrock/instructions/pricing.md`

`@plumbus/ai-bedrock` is the **Amazon Bedrock AI provider** for Plumbus. It implements `AIProviderAdapter` (Converse chat, Titan embeddings, package-owned pricing). It is an **optional peer** of `@plumbus/core` (version-locked **`0.6.x`**).

**`package.json` peer:** `"@plumbus/core": "0.6.x"` — copy literally; see `packages/plumbus-core/instructions/peer-dependencies.md`.

## When to use / when not

| Use this package | Do not use |
|------------------|------------|
| App needs Bedrock Converse / embeddings via `ctx.ai` | OpenAI-only or Anthropic Messages API-only stacks |
| AWS IAM / IRSA already available for inference | You only need core’s built-in OpenAI/Anthropic fetch adapters |
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

Missing package + `createProviderAdapter('bedrock')` → clear error: run `pnpm add @plumbus/ai-bedrock`.

Core that loads this package must prefer adapter-supplied `cost` (core **0.6.x** with the Bedrock cost hook). Older cores ignore package rates and under-report spend.

## Public exports

| Export | Role |
|--------|------|
| `createBedrockAdapter(config)` | Sync factory → `AIProviderAdapter` (`name: 'bedrock'`) |
| `BEDROCK_DEFAULT_EMBEDDING_MODEL` | `amazon.titan-embed-text-v2:0` |
| `BedrockAdapterConfig` | Config type (region, pricing file, TTL, credentials, …) |
| `BedrockPricingFileV1` / `BedrockModelRate` | Normalized pricing file types |
| `parseAwsOfferRates` / `parsePricingFile` / `normalizeBedrockModelId` | CI helpers to build / validate the pricing file |
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
| `AI_BEDROCK_ENABLED` | alt | With `AWS_REGION`, enables discovery without `AI_BEDROCK_REGION` |
| `AI_BEDROCK_MODEL` | no | Default chat model id |
| `AI_BEDROCK_EMBEDDING_MODEL` | no | Default embed model (else Titan V2) |
| `AI_BEDROCK_PRICING_FILE` | **yes in k8s** | Absolute path to normalized pricing JSON |
| `AI_BEDROCK_PRICING_TTL_MS` | no | Auto-download cache TTL (default ~24h) |
| `AI_BEDROCK_REQUEST_TIMEOUT` | no | Client timeout ms |

\*Discovery enables Bedrock when `AI_BEDROCK_REGION` is set, or `AI_BEDROCK_ENABLED=1` + `AWS_REGION`. There is **no** `AI_BEDROCK_API_KEY` — inference uses the AWS default credential chain (env keys, shared config, IRSA, instance role).

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

Chat (`@plumbus/chat`) and RAG `embed` work the same way once the provider is `bedrock`.

## Auth (IAM)

Inference uses the **AWS default credential chain** (env keys, shared config, IRSA, instance role). Optional `AWS_BEARER_TOKEN_BEDROCK` is honored by the AWS SDK when set. There is no `apiKey` on `createBedrockAdapter`.

**Not this package:** Bedrock Mantle OpenAI-compatible URLs (`bedrock-mantle.*.api.aws` + console `OPENAI_API_KEY`) use core’s `createOpenAIAdapter` — see `docs/ai/bedrock.md`.

Minimal IAM sketch for Runtime (tighten resource ARNs in production):

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
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
| `pricingFilePath` / `AI_BEDROCK_PRICING_FILE` set | Load normalized JSON; **no** Price List fetch |
| Else | Fetch `AmazonBedrock` + `AmazonBedrockFoundationModels` for `region`; memory TTL ~24h |

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
| Install / load error for `bedrock` | `pnpm add @plumbus/ai-bedrock`; core ≥ cost-hook release |
| AccessDenied / model not found | IAM + Bedrock console model access for region |
| `cost` always `0` | Missing rates for model family — see [pricing.md](./pricing.md) |
| Auto-download fails in cluster | Mount `AI_BEDROCK_PRICING_FILE` |

## Critical rules

1. **Framework-first** — business logic in `definePrompt` / capabilities / `ctx.ai`; never call Bedrock SDK from app code for product features.
2. **Do not** copy Anthropic `MODEL_PRICING` rows for Bedrock — rates diverge (e.g. Haiku 4.5 regional Bedrock ≠ Anthropic API).
3. **Containers:** prefer `AI_BEDROCK_PRICING_FILE` ([pricing.md](./pricing.md)).
4. **Peer literal** is `"0.6.x"` — never `^0.6.0`.
5. Install the package explicitly; core only `createRequire`s it when the provider name is `bedrock`.

## Where to look for more

- [pricing.md](./pricing.md) — Price List URLs, generate normalized file, k8s
- [README.md](../README.md) — quick start
- Monorepo: `docs/ai/ai-integration.md`
- Core peer rules: `packages/plumbus-core/instructions/peer-dependencies.md`
