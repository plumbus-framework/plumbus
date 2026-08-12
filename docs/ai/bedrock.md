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
10. [Embeddings](#embeddings)
11. [Pricing and cost ledger](#pricing-and-cost-ledger)
12. [IAM permissions](#iam-permissions)
13. [Kubernetes / containers](#kubernetes--containers)
14. [Prompts, chat, RAG](#prompts-chat-rag)
15. [Observability and errors](#observability-and-errors)
16. [Testing](#testing)
17. [Gaps and non-goals](#gaps-and-non-goals)
18. [Checklist before production](#checklist-before-production)

---

## What this package is (and is not)

| | |
|---|---|
| **Package** | `@plumbus/ai-bedrock` `0.1.x` |
| **Peer** | `@plumbus/core` `0.6.x` (literal range — copy from `packages/plumbus-core/instructions/peer-dependencies.md`) |
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
| Structured outputs / `outputConfig` | **Not first-class** — use tools or prompt JSON |
| Bedrock Agents / KB Retrieve | Out of scope — use RAG in core / knowledge-base |
| Mantle OpenAI proxy | Use OpenAI adapter, not this package |

**Verdict:** We match the mainstream Converse + tools + stream + Titan embed + cost path that most application backends need. Advanced Converse features (guardrails, multimodal, structured outputs) are documented gaps, not silent pretenses of support.

---

## Install and peers

```bash
pnpm add @plumbus/ai-bedrock
```

| Dependency | Range | Notes |
|------------|-------|-------|
| `@plumbus/core` (peer) | `0.6.x` | Copy literal; never `^0.6.0` |
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

```typescript
import { createProviderAdapter, createAIService } from '@plumbus/core';

const bedrock = createProviderAdapter('bedrock', {
  /* forwarded to createBedrockAdapter when package is installed */
});
```

If `@plumbus/ai-bedrock` is missing, core throws/prints an install hint.

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
| `warmPricingOnCreate` | no | Kick off warm at factory (default true when no injected store) |
| `runtimeClient` / `pricingStore` | no | Test injection |

---

## Environment variables

Discovered by `@plumbus/core` when the package is installed:

| Variable | Purpose |
|----------|---------|
| `AI_DEFAULT_PROVIDER=bedrock` | Prefer Bedrock as default provider |
| `AI_BEDROCK_REGION` | Region (required for env discovery) |
| `AI_BEDROCK_MODEL` | Default Converse model id |
| `AI_BEDROCK_EMBEDDING_MODEL` | Default embedding model id |
| `AI_BEDROCK_PRICING_FILE` | Path to mounted normalized pricing JSON |

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
| `toolChoice: 'auto'` | `{ auto: {} }` |
| named function choice | `{ tool: { name } }` |
| `toolChoice: 'none'` | **omit** `toolConfig` (Bedrock has no true none) |
| assistant `toolCalls` in history | `toolUse` content blocks |
| role `tool` messages | `toolResult` on a `user` turn |

Capabilities advertised: `tools`, `streamingTools`, `parallelToolCalls`, `namedToolChoice` (no `parallelToolCallControl`).

---

## Embeddings

`adapter.embed({ texts, model? })` loops **InvokeModel** with Titan-style `{ inputText }` bodies (default model `amazon.titan-embed-text-v2:0`).

Returns `embeddings`, `usage.totalTokens` (sum of `inputTextTokenCount`), and **`cost`**.

RAG / knowledge-base flows that call `ctx.ai.embed` with `provider: 'bedrock'` use this path. Mantle OpenAI mode typically cannot embed.

---

## Pricing and cost ledger

Bedrock Runtime never returns USD — only tokens. Cost recording:

1. Adapter attaches `cost` on complete / stream `done` / embed.
2. `createAIService` **prefers adapter `cost`** over core’s OpenAI/Anthropic `MODEL_PRICING` catalog.
3. Do **not** alias Claude-on-Bedrock to Anthropic API rows (regional rates differ).

### Modes

| Mode | Behavior |
|------|----------|
| `pricingFilePath` / `AI_BEDROCK_PRICING_FILE` | Load normalized v1 JSON; missing/invalid file **throws** on first warm |
| Auto-download | HTTPS GET Price List indexes for `region`; failure **warns**, rates empty → `$0` until fixed |

### Price List URLs (public, no IAM)

Host is always `pricing.us-east-1.amazonaws.com`; `{region}` is your Bedrock region:

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/{region}/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/{region}/index.json
```

Normalize with `parseAwsOfferRates` from this package. Full curl, Node script, ConfigMap sketch: [`packages/ai-bedrock/instructions/pricing.md`](../../packages/ai-bedrock/instructions/pricing.md).

### Cache tokens

When Converse reports `cacheReadInputTokens` / `cacheWriteInputTokens`, they map to Plumbus `cachedInputTokens` / `cacheWriteTokens`. Cost uses approximate Anthropic-style multipliers (**0.1×** read, **1.25×** write) against the Bedrock input rate. Tiny embedding costs use high decimal precision (`toFixed(10)`) so Titan micro-costs do not round to `$0`.

---

## IAM permissions

Minimum for the adapter itself (tighten by resource ARN / region as needed):

- `bedrock:Converse`
- `bedrock:ConverseStream`
- `bedrock:InvokeModel` (embeddings)

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

```typescript
definePrompt({
  name: 'summarizeTicket',
  model: {
    provider: 'bedrock',
    name: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
  // …
});
```

Chat packages (`@plumbus/chat`) and RAG ingest that use `ctx.ai` inherit the registered Bedrock adapter when `provider: 'bedrock'` (or default provider is bedrock). No Bedrock-specific chat APIs are required.

---

## Observability and errors

| Condition | Behavior |
|-----------|----------|
| `ValidationException` / `AccessDeniedException` | Thrown / streamed as `Bedrock request failed (<Name>): …` |
| Other SDK errors | Re-thrown as Error |
| Empty ConverseStream body | Stream `error` event |
| Missing embedding vector | Throws |
| Pricing file missing | Throws on warm |
| Price List download fail | Console warn; cost `$0` |

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
- **Structured outputs** / `outputConfig.textFormat`
- **Prompt caching** config fields beyond usage accounting when the model returns cache tokens
- **Bedrock Agents**, Flows, Knowledge Bases Retrieve/RetrieveAndGenerate
- **Image / video / audio** generation models
- **First-class Mantle** productization (use OpenAI adapter)
- Control-plane **ListFoundationModels** as `listModels` source

Contributions that stay within the `AIProviderAdapter` contract are welcome; do not call the Bedrock SDK from app business logic.

---

## Checklist before production

- [ ] `@plumbus/ai-bedrock@0.1.x` installed; peer `@plumbus/core` `0.6.x` satisfied (npm Docker installs verify peers — pnpm alone is insufficient)
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
- Agent recipes: [`packages/ai-bedrock/instructions/`](../../packages/ai-bedrock/instructions/)
- AI overview: [ai-integration.md](./ai-integration.md)
- Peer range policy: [`packages/plumbus-core/instructions/peer-dependencies.md`](../../packages/plumbus-core/instructions/peer-dependencies.md)
- Monorepo packages table: [root README — Packages](../../README.md#packages)
