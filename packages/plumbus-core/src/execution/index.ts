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

export {
  getCanonicalCapabilityName,
  isCanonicalCapabilityName,
} from './canonical-name.js';
export type { CanonicalCapabilityRef } from './canonical-name.js';

export {
  buildCapabilityRuntimeDeps,
  buildDependencyViolationMessage,
  buildRegistryInvoker,
  createCapabilityInvokeService,
  createUnavailableCapabilityService,
} from './capability-invocation.js';
export type {
  DependencyViolationMetadata,
  DependencyViolationReason,
  InternalCapabilityInvoker,
} from './capability-invocation.js';

export { wireContextDependencies } from './context-deps.js';
export type { WireContextDependenciesOptions } from './context-deps.js';

export {
  CapabilityOutputValidationError,
  createTransactionRunner,
  shouldUseTransactionalOutbox,
} from './transactional-outbox.js';
export type {
  DurableDispatchRunnerConfig,
  TransactionRunnerConfig,
} from './transactional-outbox.js';
