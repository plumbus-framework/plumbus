// ── Execution Module ──
// Capability execution pipeline: context factory, authorization (deny-by-default),
// capability executor (validate → authorize → execute → audit), and capability registry.
//
// Key exports: executeCapability, createExecutionContext, evaluateAccess, CapabilityRegistry

export { createExecutionContext } from './context-factory.js';
export type { ContextDependencies } from './context-factory.js';

export { executeCapability } from './capability-executor.js';
export type {
  CapabilityResult,
  ExecutionFailure,
  ExecutionResult,
} from './capability-executor.js';

export { evaluateAccess } from './authorization.js';
export type { AuthorizationResult } from './authorization.js';

export { CapabilityRegistry } from './capability-registry.js';
