# @plumbus/ai-bedrock

> **Amazon Bedrock for [Plumbus](https://github.com/plumbus-framework/plumbus) AI.** Optional AWS SDK adapter for Converse chat, ConverseStream, Titan embeddings, and **package-owned USD cost** from the AWS Price List (or a mounted pricing file).

[![npm](https://img.shields.io/npm/v/@plumbus/ai-bedrock.svg)](https://www.npmjs.com/package/@plumbus/ai-bedrock)
[![license](https://img.shields.io/npm/l/@plumbus/ai-bedrock.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. Apps call `ctx.ai` / `definePrompt` against provider adapters registered on `createAIService`.

`@plumbus/ai-bedrock` is the **Amazon Bedrock Runtime adapter**. It wraps `@aws-sdk/client-bedrock-runtime` (Converse / ConverseStream / InvokeModel), maps Plumbus tool calling and usage into Bedrock shapes, and computes cost USD because Bedrock responses return **token counts only**.

If you only need Bedrock Mantle’s OpenAI-compatible HTTP API (`bedrock-mantle.*.api.aws`), use core’s `createOpenAIAdapter` with `OPENAI_BASE_URL` — that path does **not** use this package.

## Why?

Bedrock needs the AWS SDK (SigV4 / IAM credential chain, Converse message shapes, InvokeModel embeddings). Shipping that inside `@plumbus/core` would:

- Pull AWS SDK weight into every app that never touches Bedrock
- Force core releases for every Bedrock SDK bump
- Mix IAM auth with the API-key OpenAI/Anthropic adapters

An opt-in peer keeps core lean while giving AWS shops a first-class `provider: 'bedrock'` path.

## What you get

| Surface | What it does |
|---|---|
| `createBedrockAdapter()` | `AIProviderAdapter` for `createAIService({ providers: { bedrock } })`. |
| Converse / ConverseStream | Chat complete + stream with system, tools, named `toolChoice`, multi-turn tool results. |
| InvokeModel embeddings | Default Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`). |
| Package-owned pricing | Auto-download AWS Price List by region, or `pricingFilePath` / `AI_BEDROCK_PRICING_FILE`. |
| `parseAwsOfferRates` / pricing helpers | Normalize offer JSON → mounted ConfigMap rates for k8s. |
| Env discovery (via core) | After install: `AI_BEDROCK_REGION`, `AI_BEDROCK_MODEL`, `AI_BEDROCK_PRICING_FILE`, … |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| OpenAI / Anthropic HTTP APIs | Built-in adapters in `@plumbus/core` |
| Bedrock **Mantle** OpenAI-compatible endpoint | `createOpenAIAdapter` + `OPENAI_BASE_URL=https://bedrock-mantle.<region>.api.aws/v1` |
| Bedrock **Runtime** Converse + Titan embed + IAM/IRSA cost ledger | **`@plumbus/ai-bedrock`** (this package) |

## Status

Optional peer of `@plumbus/core` (version-locked **`0.1.x`**; required peer `@plumbus/core` **`0.6.x`**). **Runtime floor:** `@plumbus/core` **≥ 0.6.16** (Bedrock provider slot, env discovery, adapter-supplied `cost`, agent wiring v13). Install alone is not enough until the adapter is registered (env discovery or `createBedrockAdapter`).

## Install

```bash
pnpm add @plumbus/ai-bedrock
```

Peer (copy literally): `@plumbus/core` `0.6.x`. See `packages/plumbus-core/instructions/peer-dependencies.md`.

If agent wiring predates Bedrock instructions, refresh:

```bash
plumbus init --patch --agent agents-md
plumbus doctor
```

## Quick start

```typescript
import { createAIService } from '@plumbus/core';
import { createBedrockAdapter } from '@plumbus/ai-bedrock';

const ai = createAIService({
  defaultProvider: 'bedrock',
  providers: {
    bedrock: createBedrockAdapter({
      region: 'us-east-1',
      // recommended in Kubernetes / locked-down networks:
      // pricingFilePath: '/config/bedrock-pricing.json',
    }),
  },
});
```

Or via env (after install):

```bash
AI_DEFAULT_PROVIDER=bedrock
AI_BEDROCK_REGION=us-east-1
AI_BEDROCK_MODEL=anthropic.claude-sonnet-4-5-20250929-v1:0
AI_BEDROCK_EMBEDDING_MODEL=amazon.titan-embed-text-v2:0
# containers (recommended):
# AI_BEDROCK_PRICING_FILE=/config/bedrock-pricing.json
# optional: AI_BEDROCK_ENABLED=1 with AWS_REGION instead of AI_BEDROCK_REGION
# optional: AI_BEDROCK_REQUEST_TIMEOUT / AI_BEDROCK_PRICING_TTL_MS
```

Then use the normal Plumbus AI surface:

```typescript
// Chat / structured generate (prompt model.provider: 'bedrock')
await ctx.ai.generateWithUsage({ prompt: 'classifyTicket', input: { ticketText } });

// Tools — same as OpenAI/Anthropic; Converse toolConfig under the hood
import { runToolLoop } from '@plumbus/core';
await runToolLoop(ctx.ai, { prompt: 'assistant.turn', input: { userMessage }, tools, execute });

// Embeddings — wire adapter into createRAGPipeline({ provider: bedrock }), then:
await ctx.ai.retrieve({ query: 'refund policy' });
```

**Auth (Runtime):** default AWS credential chain (env keys, shared config, IRSA, instance role). Optional `AWS_BEARER_TOKEN_BEDROCK` is honored by the AWS SDK when set. There is no separate “Bedrock API key” field on `createBedrockAdapter`.

## Pricing (important)

Bedrock API responses include **token usage only**, not USD. This package loads rates and attaches `cost` for the ledger.

| Mode | When to use |
|------|-------------|
| **`pricingFilePath` / `AI_BEDROCK_PRICING_FILE`** | **Recommended for containers / k8s** — mount normalized JSON; no Price List CDN egress |
| **Auto-download by `region`** | Dev / single-node / clusters that allow HTTPS to `pricing.us-east-1.amazonaws.com` |

Do **not** alias Claude-on-Bedrock to core’s Anthropic `MODEL_PRICING` rows — regional Bedrock rates diverge.

Full curl, normalize script, ConfigMap sketch: **[instructions/pricing.md](./instructions/pricing.md)**.

## Key gotchas

- **Runtime ≠ Mantle** — console `OPENAI_API_KEY` + Mantle base URL is OpenAI-compatible HTTP, not this package.
- **Model access** — Converse fails with `AccessDenied` until the account enables the model (and Anthropic use-case forms where required).
- **Embeddings** — Converse does not embed; use InvokeModel (Titan) via `createRAGPipeline({ provider })` + `ctx.ai.retrieve` / `ragPipeline.ingest`. There is no `ctx.ai.embed`. `plumbus rag ingest` does not auto-select Bedrock. Mantle typically has no embeddings.
- **Tools** — use `runToolLoop` / `generateWithUsage({ tools })`; do not call the Bedrock SDK. Stream accumulates partial tool JSON.
- **`toolChoice: 'none'`** — Bedrock has no true none; Plumbus omits `toolConfig` entirely.
- **Missing pricing file** — file mode throws on first call; auto-download failure warns and leaves cost `$0`.
- **Unmapped models (e.g. Nova)** — inference works; `cost` stays `$0` until you add a pricing-file row (display-name map covers Claude + Titan embed primarily).
- **Wiring** — after install, `plumbus init --patch` (core ≥ 0.6.16 / wiring v13) so agents see `instructions/`.

## Documentation / Agent recipes

- **Concept docs:** [`docs/ai/bedrock.md`](../../docs/ai/bedrock.md) · [`docs/ai/ai-integration.md`](../../docs/ai/ai-integration.md)
- **Live smoke (monorepo):** [`examples/ai-bedrock-smoke`](../../examples/ai-bedrock-smoke)
- **Agent recipes** (after install, open these exact paths):
  - `node_modules/@plumbus/ai-bedrock/instructions/README.md`
  - `node_modules/@plumbus/ai-bedrock/instructions/framework.md`
  - `node_modules/@plumbus/ai-bedrock/instructions/pricing.md`

## The Plumbus ecosystem

`@plumbus/ai-bedrock` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/core`](../plumbus-core/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
