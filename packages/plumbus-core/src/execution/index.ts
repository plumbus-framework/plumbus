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
