# @plumbus/ai-bedrock — agent instructions

**Exact path in a consumer app:** `node_modules/@plumbus/ai-bedrock/instructions/README.md`

| File | When to read |
|------|----------------|
| [framework.md](./framework.md) | Package boundary, install, env table, IAM sketch, model ids, wiring |
| [pricing.md](./pricing.md) | **Where to pull rates (URLs)**, curl, one-shot normalize, ConfigMap, `$0` cost debug |

## Reading order

1. **framework.md** — install + `AI_BEDROCK_*` + IAM + prompt example.
2. **pricing.md** — if you need cost recording in containers, or `cost` is always `$0`.

## Critical rules

1. Install `@plumbus/ai-bedrock` explicitly — core will not bundle the AWS SDK.
2. Use Bedrock **model ids** in prompts (`anthropic.claude-…-v1:0`, not Anthropic API short names alone).
3. For Kubernetes / containers / reliable cost, set **`pricingFilePath` / `AI_BEDROCK_PRICING_FILE`** with explicit family keys — do not rely on Price List auto-download completeness. Read [pricing.md](./pricing.md).
4. Business logic stays in Plumbus primitives (`definePrompt`, `ctx.ai.*`); this package is only the Bedrock adapter.
5. Cost USD comes from this package’s rates (file or auto-download), **not** from core’s OpenAI/Anthropic `MODEL_PRICING` table. Never alias Bedrock rates to Anthropic catalog rows.
6. Bedrock Converse responses return **token usage only** — never dollar amounts. Pricing is always usage × rates from the Price List (or your mounted file).
7. Do not confuse **Bedrock Runtime** (this package) with **Bedrock Mantle** (OpenAI-compatible HTTP → `createOpenAIAdapter`). Full guide in the monorepo: `docs/ai/bedrock.md` (also linked from the package README).
8. After install on an existing app, run `plumbus init --patch` (wiring version 13+) so agents see these instruction paths; `plumbus doctor` reports stale wiring.
9. **Tools** — `runToolLoop` / `generateWithUsage({ tools })` (see [framework.md](./framework.md)); `toolChoice: 'none'` omits `toolConfig`.
10. **Embeddings** — Titan via InvokeModel through `createRAGPipeline({ provider })` + `ctx.ai.retrieve` / `ragPipeline.ingest`; there is no `ctx.ai.embed`. `plumbus rag ingest` does not auto-pick Bedrock. Mantle usually cannot embed.

## Price List (bookmark)

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/{region}/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/{region}/index.json
```

Host stays `pricing.us-east-1.amazonaws.com`; swap `{region}` for `AI_BEDROCK_REGION`. Public HTTPS — no IAM.

Package README: [../README.md](../README.md)
