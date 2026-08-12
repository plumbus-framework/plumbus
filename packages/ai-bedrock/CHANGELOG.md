# @plumbus/ai-bedrock

## 0.1.0 — 2026-08-12 — initial release

### Added

- **`createBedrockAdapter`** — Amazon Bedrock Runtime adapter for Plumbus AI: Converse / ConverseStream chat, Titan embeddings via `InvokeModel`, multi-turn tool use.
- **Package-owned pricing** — **production:** mount `pricingFilePath` / `AI_BEDROCK_PRICING_FILE` keyed by Bedrock family ids. **Dev:** optional auto-download from AWS Price List (best-effort id extraction + limited generative display inference — **not** a hardcoded forever model catalog). Attaches `cost` on complete / stream `done` / embed (Bedrock APIs return tokens only).
- **Optional peer of `@plumbus/core` `0.6.x`** — **runtime floor ≥ 0.6.16** (provider slot, env discovery, adapter `cost` preference, agent wiring v13). Wire via env (`AI_BEDROCK_REGION`) or `createAIService({ providers: { bedrock } })`.
- **Structured outputs (opt-in)** — `structuredOutputs: 'native'` forwards `responseSchema` as Converse `outputConfig.textFormat`. Default `'off'` keeps core's validate-and-repair loop, since `outputConfig` support is model-dependent.
- **Embeddings** — Titan *and* Cohere request/response shapes (`embeddingInputType`, default `search_document`), with bounded parallelism (`embedConcurrency`, default 4) and input order preserved.
- **Pricing tiers** — regional cache read/write SKUs (`cacheReadPerMTok` / `cacheWritePerMTok`) and global inference-profile SKUs (`globalInputPerMTok` / `globalOutputPerMTok`) are parsed and honored; all optional and additive to pricing file `version: 1`.
- **Agent instructions** — `instructions/framework.md`, `instructions/pricing.md` (Price List URLs, curl, normalize, ConfigMap, troubleshooting), `instructions/README.md`.
- **Concept docs** — `docs/ai/bedrock.md` (Runtime vs Mantle, IAM, tools/streaming, pricing, production checklist).
- **Live smoke** — `examples/ai-bedrock-smoke` (Mantle OpenAI-compatible vs Runtime IAM/bearer).

### Notes

- ConverseStream sends the same `toolConfig` as Converse and accumulates partial tool-use JSON across content-block deltas.
- `toolChoice: 'none'` omits `toolConfig` (Bedrock has no true none); `'auto'` / unset omits just the `toolChoice` field, since support for it is model-dependent.
- A run of consecutive `tool` messages (parallel tool calls) is coalesced into a **single** Converse user turn carrying every `toolResult`, as the API requires.
- ConverseStream failures that arrive as stream **events** (`throttlingException`, `internalServerException`, `modelStreamErrorException`, `validationException`, `serviceUnavailableException`) emit a stream `error` event instead of a truncated `done`.
- Cache tokens are billed **additively**: Bedrock excludes `cacheReadInputTokens` / `cacheWriteInputTokens` from `inputTokens`, so they are added on top (approximate 0.1× read / 1.25× write multipliers) rather than carved out of it.
- Models with no known rate return **no `cost` field** (never `0`), so core falls back to `calculateModelCost` instead of recording unpriced spend as free.
- Pricing lookup falls back from `amazon.nova-lite-v1` to `amazon.nova-lite`, so both family-key shapes resolve. First-party Titan embedding rows are keyed from the `titanModel` offer attribute.
- Offer rows whose unit is not a token unit (`hour`, `image`, `1M TPM Hour`, …) are skipped rather than assumed to be per-1M-token prices, and the **lowest** standard-tier SKU wins so rates do not depend on JSON key order.
- `content_filtered` / `guardrail_intervened` map to `refusal` and `model_context_window_exceeded` to `length`, instead of falling through to `other`.
- `listModels` honors the `AIProviderAdapter` contract: warn once and return `[]` rather than throwing. Inference still fails loudly on a missing/invalid pricing file.
- Failed Price List downloads back off 5 minutes; TTL refreshes happen in the background while the previous rates keep serving.
- Do not confuse Bedrock **Runtime** (this package) with Bedrock **Mantle** (`createOpenAIAdapter` + Mantle base URL).
