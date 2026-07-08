import type { z } from 'zod';
import { isProviderAPIError } from '../ai/provider.js';
import { isPlumbusError } from '../errors/index.js';
import type { CapabilityContract } from '../types/capability.js';
import type { ExecutionContext, TransactionScope } from '../types/context.js';
import type { PlumbusErrorLike } from '../types/errors.js';
import { evaluateAccess } from './authorization.js';
import { getCanonicalCapabilityName } from './canonical-name.js';
import { createDeferredFlowService } from './deferred-flow-service.js';
import { createDeferredJobDispatchService } from '../jobs/deferred-job-dispatch-service.js';
import {
  createCapabilityInvokeService,
  createUnavailableCapabilityService,
  stripHandlerRuntime,
  type CapabilityInvocationRuntime,
} from './capability-invocation.js';
import {
  CapabilityOutputValidationError,
  shouldUseTransactionalOutbox,
} from './transactional-outbox.js';

export interface ExecutionResult<T = unknown> {
  success: true;
  data: T;
}

export interface ExecutionFailure {
  success: false;
  error: PlumbusErrorLike;
}

export type CapabilityResult<T = unknown> = ExecutionResult<T> | ExecutionFailure;

function buildHandlerContext(
  ctx: ExecutionContext,
  capability: CapabilityContract,
  invocationRuntime: CapabilityInvocationRuntime | undefined,
  scope?: TransactionScope,
): ExecutionContext {
  const handlerRuntime = stripHandlerRuntime(ctx.__runtime);
  const deferred = scope?.deferred;
  const flows =
    scope && deferred && ctx.flows ? createDeferredFlowService(ctx.flows, deferred) : ctx.flows;
  const jobs =
    scope && deferred && ctx.jobs ? createDeferredJobDispatchService(ctx.jobs, deferred) : ctx.jobs;
  const handlerCtx: ExecutionContext = {
    ...ctx,
    ...(scope ? { data: scope.data, events: scope.events } : {}),
    ...(flows ? { flows } : {}),
    ...(jobs ? { jobs } : {}),
    capabilities: createUnavailableCapabilityService(ctx),
    __runtime: {
      ...handlerRuntime,
      ...(scope ? { transactionScope: scope } : {}),
      deferredPostCommit: scope?.deferred ?? ctx.__runtime?.deferredPostCommit,
      withTransaction: scope ? undefined : ctx.__runtime?.withTransaction,
    },
  };
  handlerCtx.capabilities = invocationRuntime
    ? createCapabilityInvokeService(
        capability as unknown as CapabilityContract<z.ZodTypeAny, z.ZodTypeAny>,
        handlerCtx,
        invocationRuntime,
        ctx,
      )
    : createUnavailableCapabilityService(handlerCtx);
  return handlerCtx;
}

async function runHandlerWithOutputValidation<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(
  capability: CapabilityContract<TInput, TOutput>,
  handlerCtx: ExecutionContext,
  input: z.infer<TInput>,
): Promise<z.infer<TOutput>> {
  const rawOutput = await capability.handler(handlerCtx, input);
  const outputResult = capability.output.safeParse(rawOutput);
  if (!outputResult.success) {
    throw new CapabilityOutputValidationError(outputResult.error.issues);
  }
  return outputResult.data as z.infer<TOutput>;
}

async function handleExecutionError<TOutput extends z.ZodTypeAny>(
  err: unknown,
  ctx: ExecutionContext,
  capability: CapabilityContract<z.ZodTypeAny, TOutput>,
  canonicalName: string,
): Promise<CapabilityResult<z.infer<TOutput>>> {
  if (err instanceof CapabilityOutputValidationError) {
    const error = ctx.errors.internal('Invalid output from capability', {
      capability: canonicalName,
      issues: err.issues,
    });
    ctx.logger.error(`Capability "${canonicalName}" returned invalid output`, {
      issues: err.issues,
    });
    await recordAudit(ctx, capability, canonicalName, 'failure', { error });
    return { success: false, error };
  }

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
}

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

  if (emitScope) {
    emitScope.executingCapability = canonicalName;
  }

  const anyCap = capability as unknown as CapabilityContract<z.ZodTypeAny, z.ZodTypeAny>;

  const useTransactional = shouldUseTransactionalOutbox(anyCap, ctx);
  const existingScope = ctx.__runtime?.transactionScope;
  const withTransaction = ctx.__runtime?.withTransaction;
  const isNestedInTransaction = Boolean(existingScope);

  let validatedOutput: z.infer<TOutput> | undefined;

  try {
    if (useTransactional && existingScope) {
      const handlerCtx = buildHandlerContext(ctx, anyCap, invocationRuntime, existingScope);
      validatedOutput = await runHandlerWithOutputValidation(anyCap, handlerCtx, input);
    } else if (useTransactional && withTransaction) {
      validatedOutput = await withTransaction(async (scope) => {
        const handlerCtx = buildHandlerContext(ctx, anyCap, invocationRuntime, scope);
        return runHandlerWithOutputValidation(anyCap, handlerCtx, input);
      });
    } else {
      const handlerCtx = buildHandlerContext(ctx, anyCap, invocationRuntime);
      validatedOutput = await runHandlerWithOutputValidation(anyCap, handlerCtx, input);
    }
  } catch (err) {
    if (isNestedInTransaction) {
      if (isPlumbusError(err)) {
        await recordAudit(ctx, anyCap, canonicalName, 'failure', { error: err });
      } else if (err instanceof CapabilityOutputValidationError) {
        const error = ctx.errors.internal('Invalid output from capability', {
          capability: canonicalName,
          issues: err.issues,
        });
        await recordAudit(ctx, anyCap, canonicalName, 'failure', { error });
      } else {
        const error = ctx.errors.internal('Capability execution failed', {
          capability: canonicalName,
          message: err instanceof Error ? err.message : String(err),
        });
        await recordAudit(ctx, anyCap, canonicalName, 'failure', { error });
      }
      throw err;
    }
    const failure = await handleExecutionError(err, ctx, anyCap, canonicalName);
    return failure;
  } finally {
    if (emitScope) {
      emitScope.executingCapability = undefined;
    }
  }

  if (isNestedInTransaction && existingScope) {
    const deferred = existingScope.deferred ?? [];
    existingScope.deferred = deferred;
    deferred.push(async () => {
      await recordAudit(ctx, capability, canonicalName, 'success');
    });
  } else if (ctx.__runtime?.deferredPostCommit) {
    // Nested outside shared tx scope (e.g. AI) but still under a parent transaction —
    // defer success audit so a parent rollback does not leave a false success row.
    ctx.__runtime.deferredPostCommit.push(async () => {
      await recordAudit(ctx, capability, canonicalName, 'success');
    });
  } else if (!isNestedInTransaction) {
    await recordAudit(ctx, capability, canonicalName, 'success');
  }

  return { success: true, data: validatedOutput as z.infer<TOutput> };
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
