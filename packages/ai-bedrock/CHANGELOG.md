# @plumbus/ai-bedrock

## 0.1.0

### Added

- Initial release: `createBedrockAdapter` for Amazon Bedrock Converse / ConverseStream chat and Titan embeddings via `InvokeModel`.
- Package-owned pricing: auto-download AWS Price List rates for the adapter region, or load a normalized `pricingFilePath` (recommended for containers/k8s).
- Optional peer of `@plumbus/core` `0.6.x`; wire via env (`AI_BEDROCK_REGION`) or programmatic `createAIService({ providers: { bedrock } })`.
- Agent instructions: `instructions/framework.md`, `instructions/pricing.md` (Price List URLs, curl, one-shot normalize, ConfigMap, troubleshooting), `instructions/README.md`.
- ConverseStream sends the same `toolConfig` as Converse and accumulates partial tool-use JSON across content-block deltas.
- Detailed concept docs: `docs/ai/bedrock.md`.
