// ── Explanation Module ──
// Explainability tracking: records why the system made each decision
// (authorization, AI invocations, flow branching, governance signals).
//
// Key exports: createExplanationTracker

export { createExplanationTracker } from './tracker.js';
export type {
  AIInvocationExplanation,
  AuthorizationExplanation,
  ExplanationFilter,
  ExplanationRecord,
  ExplanationTracker,
  ExplanationTrackerConfig,
  ExplanationType,
  FlowBranchExplanation,
  GovernanceExplanation,
} from './tracker.js';
