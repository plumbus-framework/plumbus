/** Optional TypeSafe/Jev adapter for the shared Plumbus decision protocol. */
export {
  createTypeSafeDecisionAdapter,
  TypeSafeDecisionInputRates,
  type TypeSafeDecisionAdapterConfig,
} from './typesafe-adapter.js';
export type {
  DecisionProviderAdapter,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
} from '@plumbus/ai-decision';
export { DecisionProviderError } from '@plumbus/ai-decision';
