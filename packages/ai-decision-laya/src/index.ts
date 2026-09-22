/** Optional HTTP adapter for self-hosted Laya typed decision inference. */
export { createLayaDecisionAdapter, type LayaDecisionAdapterConfig } from './laya-adapter.js';
export type {
  DecisionProviderAdapter,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
} from '@plumbus/ai-decision';
export { DecisionProviderError } from '@plumbus/ai-decision';
