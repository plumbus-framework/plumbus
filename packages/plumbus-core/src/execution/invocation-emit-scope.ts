/** Mutable scope for nested capability event causation (wired into event emitters). */
export interface InvocationEmitScope {
  /** Canonical name of the capability currently executing its handler. */
  executingCapability?: string;
  /** Canonical name of the caller when running a nested callee handler. */
  invocationCaller?: string;
}

export function createInvocationEmitScope(): InvocationEmitScope {
  return {};
}

/** Causation for nested emits: caller canonical name, else the executing capability. */
export function resolveInvocationCausationId(scope?: InvocationEmitScope): string | undefined {
  return scope?.invocationCaller ?? scope?.executingCapability;
}
