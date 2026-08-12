# @plumbus/ai-bedrock

## 0.1.0 — 2026-08-12 — initial release

### Added

- **`createBedrockAdapter`** — Amazon Bedrock Runtime adapter for Plumbus AI: Converse / ConverseStream chat, Titan embeddings via `InvokeModel`, multi-turn tool use.
- **Package-owned pricing** — auto-download AWS Price List rates for the adapter region, or load a normalized `pricingFilePath` / `AI_BEDROCK_PRICING_FILE` (recommended for containers/k8s). Attaches `cost` on complete / stream `done` / embed (Bedrock APIs return tokens only).
- **Optional peer of `@plumbus/core` `0.6.x`** — **runtime floor ≥ 0.6.16** (provider slot, env discovery, adapter `cost` preference, agent wiring v13). Wire via env (`AI_BEDROCK_REGION`) or `createAIService({ providers: { bedrock } })`.
- **Agent instructions** — `instructions/framework.md`, `instructions/pricing.md` (Price List URLs, curl, normalize, ConfigMap, troubleshooting), `instructions/README.md`.
- **Concept docs** — `docs/ai/bedrock.md` (Runtime vs Mantle, IAM, tools/streaming, pricing, production checklist).
- **Live smoke** — `examples/ai-bedrock-smoke` (Mantle OpenAI-compatible vs Runtime IAM/bearer).

### Notes

- ConverseStream sends the same `toolConfig` as Converse and accumulates partial tool-use JSON across content-block deltas.
- `toolChoice: 'none'` omits `toolConfig` (Bedrock has no true none).
- Do not confuse Bedrock **Runtime** (this package) with Bedrock **Mantle** (`createOpenAIAdapter` + Mantle base URL).
