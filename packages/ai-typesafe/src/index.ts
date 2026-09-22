/**
 * @plumbus/ai-typesafe — TypeSafe (Jev) provider for Plumbus AI.
 *
 * Two surfaces, one credential:
 *
 * - `createTypeSafeDecisionAdapter` implements `DecisionProviderAdapter` and
 *   backs `ctx.ai.decide()` — typed noul / choice / score questions answered
 *   with calibrated probabilities and confidence.
 * - `createTypeSafeAdapter` implements `AIProviderAdapter` with a native
 *   `classify` hook, so `ctx.ai.classify()` runs on Jev. Generation
 *   (`complete` / `stream` / `embed`) throws, because Jev produces no text.
 *
 * See `instructions/` for prescriptive recipes and `docs/ai/typesafe.md` in
 * the monorepo for the full guide.
 */

export { createTypeSafeAdapter } from './classify-adapter.js';
export { createTypeSafeDecisionAdapter, JEV_CAPABILITIES } from './decision-adapter.js';
export { mapTypeSafeError, PROVIDER_NAME } from './errors.js';
export { calculateJevCost, findJevInputRate } from './pricing.js';
export type {
  TypeSafeAdapterConfig,
  TypeSafeClassifyAdapterConfig,
  TypeSafeModelCard,
} from './types.js';

// Re-export the SDK's question builders so consumers do not need a second
// direct dependency to write questions. Core exports structurally identical
// `noul`/`choice`/`score` helpers; either set works with `ctx.ai.decide()`.
export { choice, noul, score } from '@typesafe-ai/sdk';
