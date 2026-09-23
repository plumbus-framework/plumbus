/** Shared typed decision protocol and adapter utilities. Core runtime integration is separate. */
export type {
  DecisionJson,
  DecisionState,
  DecisionDescription,
  DecisionQuestion,
  DecisionQuestions,
  DecisionRequest,
  DecisionChoiceAnswer,
  DecisionScoreAnswer,
  DecisionProbabilityAnswer,
  DecisionAnswerFor,
  DecisionAnswers,
  DecisionUsage,
  DecisionResult,
  DecisionProviderAdapter,
  DecisionHttpConfig,
} from './types.js';
export { DecisionProviderError, type DecisionErrorKind } from './errors/index.js';
export { createDecisionHttpTransport } from './http.js';
export { DecisionJsonSchema } from './json.js';
export {
  validateDecisionRequest,
  parseDecisionResponse,
  toSystemOneQuestions,
} from './validation.js';
