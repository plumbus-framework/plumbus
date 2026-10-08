/** Optional OpenAI Decisions API adapter for the shared Plumbus decision protocol. */
export {
  createOpenAIDecisionAdapter,
  OpenAIDecisionInputRates,
  type OpenAIDecisionAdapterConfig,
} from './openai-adapter.js';
export type {
  DecisionProviderAdapter,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
} from '@plumbus/ai-decision';
export { DecisionProviderError } from '@plumbus/ai-decision';
