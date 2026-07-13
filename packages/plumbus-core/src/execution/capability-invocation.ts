import { CapabilityKind } from '../types/enums.js';
import type { CapabilityContract } from '../types/capability.js';
import type {
  CapabilityDescription,
  CapabilityService,
  ExecutionContext,
  ExecutionRuntimeMetadata,
} from '../types/context.js';
import type { RegisteredCapabilityName } from '../types/registry.js';
import { zodInputToJsonSchema } from '../schema/zod-input-to-json-schema.js';
import type { CapabilityRegistry } from './capability-registry.js';
import { getCanonicalCapabilityName } from './canonical-name.js';
import type { CapabilityResult } from './capability-executor.js';
import { executeCapability } from './capability-executor.js';
import type { InvocationEmitScope } from './invocation-emit-scope.js';

export type DependencyViolationReason =
  | 'undeclaredInvocation'
  | 'circularInvocation'
  | 'missingCapability'
  | 'invocationUnavailable'
  | 'unsupportedTargetKind';

export interface DependencyViolationMetadata {
  caller?: string;
  target: string;
  reason: DependencyViolationReason;
  capabilityStack: readonly string[];
}

export type InternalCapabilityInvoker = (
  name: string,
  ctx: ExecutionContext,
  input: unknown,
) => Promise<CapabilityResult<unknown>>;

export interface CapabilityInvocationRuntime {
  invoker: InternalCapabilityInvoker;
  resolveCapability: (name: string) => CapabilityContract | undefined;
  emitScope?: InvocationEmitScope;
}

/** Strip internal invoker/registry/emit scope from handler-visible runtime metadata. */
export function stripHandlerRuntime(
  runtime?: ExecutionRuntimeMetadata,
): ExecutionRuntimeMetadata | undefined {
  if (!runtime) return undefined;
  const {
    invokeCapability: _invoker,
    resolveCapability: _resolve,
    invocationEmitScope: _emitScope,
    ...handlerVisible
  } = runtime;
  return handlerVisible;
}

/** Runtime deps for nested capability invocation (wire into ContextDependencies). */
export function buildCapabilityRuntimeDeps(registry: CapabilityRegistry): {
  invokeCapability: InternalCapabilityInvoker;
  resolveCapability: (name: string) => CapabilityContract | undefined;
} {
  return {
    invokeCapability: buildRegistryInvoker(registry),
    resolveCapability: (name: string) => registry.get(name),
  };
}

export function buildRegistryInvoker(registry: CapabilityRegistry): InternalCapabilityInvoker {
  return async (name, ctx, input) => {
    const capability = registry.get(name);
    if (!capability) {
      return {
        success: false,
        error: ctx.errors.notFound(`Capability "${name}" not found`, { capability: name }),
      };
    }
    return executeCapability(capability, ctx, input);
  };
}

export function buildDependencyViolationMessage(metadata: DependencyViolationMetadata): string {
  const { caller, target, reason, capabilityStack } = metadata;
  switch (reason) {
    case 'undeclaredInvocation':
      return `Capability ${caller ?? '(unknown)'} attempted to invoke ${target}, but ${target} is not declared in ${caller ?? '(unknown)'} effects.capabilities.`;
    case 'circularInvocation':
      return `Circular capability invocation detected: ${[...capabilityStack, target].join(' -> ')}.`;
    case 'missingCapability':
      return `Capability ${caller ?? '(unknown)'} declared or attempted to invoke ${target}, but no registered capability with that name exists.`;
    case 'invocationUnavailable':
      return 'Capability invocation is unavailable in this execution context because no capability registry-backed invoker was provided.';
    case 'unsupportedTargetKind':
      return `Capability ${caller ?? '(unknown)'} attempted to invoke ${target}, but job capabilities cannot be invoked synchronously — use job dispatch, flows, or events instead.`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function throwDependencyViolation(
  ctx: ExecutionContext,
  metadata: DependencyViolationMetadata,
): never {
  const message = buildDependencyViolationMessage(metadata);
  throw ctx.errors.dependencyViolation(message, { ...metadata });
}

function shouldShareTransactionScope(target: CapabilityContract): boolean {
  if (target.effects.ai === true) return false;
  if ((target.effects.external ?? []).length > 0) return false;
  return target.kind === CapabilityKind.Action || target.kind === CapabilityKind.EventHandler;
}

function isDeclaredCapabilityDependency(capability: CapabilityContract, target: string): boolean {
  return (capability.effects.capabilities ?? []).includes(target);
}

function describeCapability(
  resolveCapability: (name: string) => CapabilityContract | undefined,
  name: string,
): CapabilityDescription | undefined {
  const cap = resolveCapability(name);
  if (!cap) return undefined;
  return {
    name: cap.name,
    domain: cap.domain,
    kind: cap.kind,
    inputSchema: zodInputToJsonSchema(cap.input),
  };
}

/**
 * Build the public `ctx.capabilities` service for a running capability handler.
 * @param ctx Handler-visible context (may carry tx-scoped data/events).
 * @param runtimeCtx Source for internal invocation runtime on nested calls (defaults to `ctx`).
 */
export function createCapabilityInvokeService(
  capability: CapabilityContract,
  ctx: ExecutionContext,
  runtime: CapabilityInvocationRuntime,
  runtimeCtx: ExecutionContext = ctx,
): CapabilityService {
  const caller = getCanonicalCapabilityName(capability);
  const { invoker, resolveCapability, emitScope } = runtime;

  return {
    describe(name: RegisteredCapabilityName) {
      return describeCapability(resolveCapability, name);
    },
    async invoke(name: RegisteredCapabilityName, input: unknown): Promise<unknown> {
      const stack = ctx.__runtime?.capabilityStack ?? [];

      if (!isDeclaredCapabilityDependency(capability, name)) {
        throwDependencyViolation(ctx, {
          caller,
          target: name,
          reason: 'undeclaredInvocation',
          capabilityStack: stack,
        });
      }

      if (stack.includes(name)) {
        throwDependencyViolation(ctx, {
          caller,
          target: name,
          reason: 'circularInvocation',
          capabilityStack: stack,
        });
      }

      const targetCap = resolveCapability(name);
      if (!targetCap) {
        throwDependencyViolation(ctx, {
          caller,
          target: name,
          reason: 'missingCapability',
          capabilityStack: stack,
        });
      }

      if (targetCap.kind === CapabilityKind.Job) {
        throwDependencyViolation(ctx, {
          caller,
          target: name,
          reason: 'unsupportedTargetKind',
          capabilityStack: stack,
        });
      }

      const parentScope = ctx.__runtime?.transactionScope;
      if (parentScope && targetCap.effects.ai === true) {
        const scopeWithFlag = parentScope as typeof parentScope & { aiTxnWarned?: boolean };
        if (!scopeWithFlag.aiTxnWarned) {
          ctx.logger.warn(
            `Capability ${caller} invoked AI capability ${name} inside an active transaction — the parent transaction is held open for the LLM call. Set transactional: false on the parent or avoid AI invokes inside transactional handlers.`,
            { caller, target: name },
          );
          scopeWithFlag.aiTxnWarned = true;
        }
      }
      const nestedCtx: ExecutionContext = {
        ...ctx,
        __runtime: {
          ...runtimeCtx.__runtime,
          capabilityStack: [...stack, caller],
          invocationCaller: caller,
          transactionScope:
            parentScope && shouldShareTransactionScope(targetCap) ? parentScope : undefined,
          deferredPostCommit: parentScope?.deferred ?? ctx.__runtime?.deferredPostCommit,
          withTransaction: parentScope ? undefined : ctx.__runtime?.withTransaction,
        },
      };

      const prevInvocationCaller = emitScope?.invocationCaller;
      if (emitScope) {
        emitScope.invocationCaller = caller;
      }
      let result: CapabilityResult<unknown>;
      try {
        result = await invoker(name, nestedCtx, input);
      } finally {
        if (emitScope) {
          emitScope.invocationCaller = prevInvocationCaller;
        }
      }

      if (!result.success) {
        throw result.error;
      }

      return result.data;
    },
  };
}

/** Invoke surface that always reports invocation unavailability. */
export function createUnavailableCapabilityService(ctx: ExecutionContext): CapabilityService {
  const resolve = ctx.__runtime?.resolveCapability;
  return {
    describe(name: RegisteredCapabilityName) {
      return resolve ? describeCapability(resolve, name) : undefined;
    },
    async invoke(name: RegisteredCapabilityName): Promise<unknown> {
      throwDependencyViolation(ctx, {
        target: name,
        reason: 'invocationUnavailable',
        capabilityStack: ctx.__runtime?.capabilityStack ?? [],
      });
    },
  };
}
