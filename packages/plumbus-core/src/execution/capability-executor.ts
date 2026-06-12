import type { z } from 'zod';
import { isProviderAPIError } from '../ai/provider.js';
import { isPlumbusError } from '../errors/index.js';
import type { CapabilityContract } from '../types/capability.js';
import type { ExecutionContext } from '../types/context.js';
import type { PlumbusErrorLike } from '../types/errors.js';
import { evaluateAccess } from './authorization.js';
import { getCanonicalCapabilityName } from './canonical-name.js';
import {
  createCapabilityInvokeService,
  createUnavailableCapabilityService,
  stripHandlerRuntime,
  type CapabilityInvocationRuntime,
} from './capability-invocation.js';

export interface ExecutionResult<T = unknown> {
  success: true;
  data: T;
}

export interface ExecutionFailure {
  success: false;
  error: PlumbusErrorLike;
}

export type CapabilityResult<T = unknown> = ExecutionResult<T> | ExecutionFailure;

/**
 * Execute a capability through the full pipeline:
 * 1. Validate input
 * 2. Evaluate access policy
 * 3. Execute handler (with scoped ctx.capabilities)
 * 4. Validate output
 * 5. Record audit
 */
export async function executeCapability<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  capability: CapabilityContract<TInput, TOutput>,
  ctx: ExecutionContext,
  rawInput: unknown,
): Promise<CapabilityResult<z.infer<TOutput>>> {
  const canonicalName = getCanonicalCapabilityName(capability);

  // 1. Validate input against schema
  const inputResult = capability.input.safeParse(rawInput);
  if (!inputResult.success) {
    const error = ctx.errors.validation('Invalid input', {
      capability: canonicalName,
      issues: inputResult.error.issues,
    });
    await recordAudit(ctx, capability, canonicalName, 'failure', { error });
    return { success: false, error };
  }

  const input = inputResult.data as z.infer<TInput>;

  // 2. Evaluate access policy (deny-by-default)
  const authResult = evaluateAccess(capability.access, ctx.auth);
  if (!authResult.allowed) {
    const error = ctx.errors.forbidden(authResult.reason ?? 'Access denied', {
      capability: canonicalName,
    });
    await recordAudit(ctx, capability, canonicalName, 'denied', { error });
    return { success: false, error };
  }

  // 3. Execute handler with scoped capabilities service (invoker not exposed on __runtime)
  const invoker = ctx.__runtime?.invokeCapability;
  const resolveCapability = ctx.__runtime?.resolveCapability;
  const emitScope = ctx.__runtime?.invocationEmitScope;
  const invocationRuntime: CapabilityInvocationRuntime | undefined =
    invoker && resolveCapability
      ? { invoker: invoker as CapabilityInvocationRuntime['invoker'], resolveCapability, emitScope }
      : undefined;

  const handlerCtx: ExecutionContext = {
    ...ctx,
    capabilities: invocationRuntime
      ? createCapabilityInvokeService(
          capability as unknown as CapabilityContract<z.ZodTypeAny, z.ZodTypeAny>,
          ctx,
          invocationRuntime,
        )
      : createUnavailableCapabilityService(ctx),
    __runtime: stripHandlerRuntime(ctx.__runtime),
  };

  if (emitScope) {
    emitScope.executingCapability = canonicalName;
  }

  let rawOutput: z.infer<TOutput>;
  try {
    rawOutput = await capability.handler(handlerCtx, input);
  } catch (err) {
    // If the handler threw a PlumbusError, surface it directly
    if (isPlumbusError(err)) {
      await recordAudit(ctx, capability, canonicalName, 'failure', { error: err });
      return { success: false, error: err };
    }

    if (isProviderAPIError(err) && err.retryable) {
      const statusCode = err.statusCode === 429 ? 503 : (err.statusCode ?? 503);
      const error = ctx.errors.internal(
        'AI provider temporarily unavailable. Please try again in a moment.',
        {
          capability: canonicalName,
          message: err.message,
          provider: err.providerName,
          retryAttempts: err.attempts,
          retryable: true,
          upstreamStatusCode: err.statusCode,
          httpStatus: statusCode,
        },
      );
      ctx.logger.error(`Capability "${canonicalName}" failed due to transient AI provider error`, {
        error: err.message,
        provider: err.providerName,
        upstreamStatusCode: err.statusCode,
        attempts: err.attempts,
      });
      await recordAudit(ctx, capability, canonicalName, 'failure', { error });
      return { success: false, error };
    }

    const causeMessage =
      err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    const errorMessage = causeMessage
      ? `${causeMessage} — ${err instanceof Error ? err.message : String(err)}`
      : err instanceof Error
        ? err.message
        : String(err);
    const error = ctx.errors.internal('Capability execution failed', {
      capability: canonicalName,
      message: errorMessage,
    });
    ctx.logger.error(`Capability "${canonicalName}" threw an error`, {
      error: errorMessage,
    });
    await recordAudit(ctx, capability, canonicalName, 'failure', { error });
    return { success: false, error };
  } finally {
    if (emitScope) {
      emitScope.executingCapability = undefined;
    }
  }

  // 4. Validate output against schema
  const outputResult = capability.output.safeParse(rawOutput);
  if (!outputResult.success) {
    const error = ctx.errors.internal('Invalid output from capability', {
      capability: canonicalName,
      issues: outputResult.error.issues,
    });
    ctx.logger.error(`Capability "${canonicalName}" returned invalid output`, {
      issues: outputResult.error.issues,
    });
    await recordAudit(ctx, capability, canonicalName, 'failure', { error });
    return { success: false, error };
  }

  // 5. Record success audit
  await recordAudit(ctx, capability, canonicalName, 'success');

  return { success: true, data: outputResult.data as z.infer<TOutput> };
}

async function recordAudit(
  ctx: ExecutionContext,
  capability: CapabilityContract<any, any>,
  canonicalName: string,
  outcome: 'success' | 'failure' | 'denied',
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (capability.audit?.enabled === false) return;

  const auditEvent = capability.audit?.event ?? `capability.${canonicalName}`;
  const stack = ctx.__runtime?.capabilityStack ?? [];
  const caller = ctx.__runtime?.invocationCaller;
  const correlationId = ctx.__runtime?.correlationId;

  try {
    await ctx.audit.record(auditEvent, {
      capability: canonicalName,
      domain: capability.domain,
      kind: capability.kind,
      outcome,
      actor: ctx.auth.userId,
      tenantId: ctx.auth.tenantId,
      ...(caller ? { caller } : {}),
      ...(stack.length > 0 ? { capabilityStack: stack } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...metadata,
    });
  } catch {
    ctx.logger.error(`Failed to record audit for capability "${canonicalName}"`);
  }
}
