/**
 * @plumbus/ai-bedrock — Amazon Bedrock adapter for Plumbus AI (`AIProviderAdapter`).
 *
 * Use Converse for chat and InvokeModel for Titan embeddings. Pricing is
 * package-owned (auto-download by region or `pricingFilePath`).
 */

export { createBedrockAdapter } from './bedrock-adapter.js';
export {
  BEDROCK_DEFAULT_EMBEDDING_MODEL,
  type BedrockAdapterConfig,
  type BedrockModelRate,
  type BedrockPricingFileV1,
} from './types.js';
export {
  createPricingStore,
  extractModelIdFromOfferAttrs,
  inferFamilyFromDisplayName,
  normalizeBedrockModelId,
  parseAwsOfferRates,
  parsePricingFile,
  type BedrockPricingStore,
} from './pricing.js';
