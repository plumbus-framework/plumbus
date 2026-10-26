import { safeParseBounded } from '../validation/bounded-parse.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { z } from 'zod';
import { isProviderAPIError } from '../ai/provider.js';
import { isPlumbusError } from '../errors/index.js';
import type { CapabilityContract } from '../types/capability.js';
import type { ExecutionContext, TransactionScope } from '../types/context.js';
import { CapabilityKind } from '../types/enums.js';
import type { PlumbusErrorLike } from '../types/errors.js';
import { accessDenialError, evaluateAccess } from './authorization.js';
import { getCanonicalCapabilityName } from './canonical-name.js';
import { createDeferredFlowService } from './deferred-flow-service.js';
import { createDeferredJobDispatchService } from '../jobs/deferred-job-dispatch-service.js';
import {
  createCapabilityInvokeService,
  createUnavailableCapabilityService,
  stripHandlerRuntime,
  type CapabilityInvocationRuntime,
} from './capability-invocation.js';
import { evaluateApprovalGate } from '../approvals/gate.js';
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

/** Options for one `executeCapability` call. */
export interface ExecuteCapabilityOptions {
  /**
   * Runs inside the capability's business transaction, after the handler and output
   * validation and before commit, with that transaction's handle — work that must commit
   * together with the capability's writes or not at all (the HTTP idempotency completion
   * record). Not called when the capability runs outside a transaction (queries, `transactional:
   * false`, AI or external effects, the outbox kill switch) or the transaction exposes no
   * database handle; a throw rolls the transaction back and fails the call.
   */
  beforeCommit?: (tx: PostgresJsDatabase, output: unknown) => Promise<void>;
}

/** Static access is independent of input and must precede schema parsing. */
async function authorizeAccessPolicy(
  capability: CapabilityContract,
  ctx: ExecutionContext,
): Promise<CapabilityResult<void>> {
  const access = evaluateAccess(capability.access, ctx.auth);
  if (access.allowed) return { success: true, data: undefined };
  const canonicalName = getCanonicalCapabilityName(capability);
  const error = accessDenialError(access, { capability: canonicalName });
  await recordAudit(ctx, capability, canonicalName, 'denied', { error });
  return { success: false, error };
}

/** Check current access without invoking a mutation or consuming an approval. */
export async function authorizeCapability<TInput extends z.ZodTypeAny>(
  capability: CapabilityContract<TInput>,
  ctx: ExecutionContext,
  input: z.infer<TInput>,
): Promise<CapabilityResult<void>> {
  const canonicalName = getCanonicalCapabilityName(capability);
  const contract = capability as unknown as CapabilityContract;
  const access = await authorizeAccessPolicy(contract, ctx);
  if (!access.success) return access;
  try {
    // Authorization is a read-only phase, with no capability invocation runtime exposed.
    await capability.authorize?.(buildHandlerContext(ctx, contract, undefined), input);
    return { success: true, data: undefined };
  } catch (error) {
    if (isPlumbusError(error)) {
      await recordAudit(ctx, capability, canonicalName, 'denied', { error });
      return { success: false, error };
    }
    return handleExecutionError(error, ctx, contract, canonicalName);
  }
}

function buildHandlerContext(
  ctx: ExecutionContext,
  capability: CapabilityContract,
  invocationRuntime: CapabilityInvocationRuntime | undefined,
  scope?: TransactionScope,
): ExecutionContext {
  const handlerRuntime = stripHandlerRuntime(ctx.__runtime, {
    preserveCapabilityRuntime: getCanonicalCapabilityName(capability) === 'chat.chatConfirmAction',
  });
  const deferred = scope?.deferred;
  // The start waits for commit; its intent is written in the transaction when the scope names
  // the database it runs on, so a crash between commit and start does not lose it.
  const flows =
    scope && deferred && ctx.flows
      ? createDeferredFlowService(
          ctx.flows,
          deferred,
          undefined,
          scope.db && scope.planeDb
            ? { tx: scope.db, planeDb: scope.planeDb, auth: ctx.auth, logger: ctx.logger }
            : undefined,
          // A wake runs after commit, where its outcome reaches no caller: log it.
          ctx.logger,
        )
      : ctx.flows;
  const jobs =
    scope && deferred && ctx.jobs
      ? scope.db && ctx.jobs.inTransaction
        ? ctx.jobs.inTransaction(scope.db, deferred)
        : createDeferredJobDispatchService(ctx.jobs, deferred)
      : ctx.jobs;
  const handlerCtx: ExecutionContext = {
    ...ctx,
    ...(scope ? { data: scope.data, events: scope.events } : {}),
    // Audit inside the transaction uses its connection, not a second pool connection.
    ...(scope?.audit ? { audit: scope.audit } : {}),
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
 * 1. Evaluate static access policy
 * 2. Validate input and run input-aware authorization
 * 3. Approval gate (consequential risk tier)
 * 4. Execute handler (with scoped ctx.capabilities)
 * 5. Validate output
 * 6. Record audit
 */
export async function executeCapability<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  capability: CapabilityContract<TInput, TOutput>,
  ctx: ExecutionContext,
  rawInput: unknown,
  options?: ExecuteCapabilityOptions,
): Promise<CapabilityResult<z.infer<TOutput>>> {
  const canonicalName = getCanonicalCapabilityName(capability);

  const access = await authorizeAccessPolicy(capability as unknown as CapabilityContract, ctx);
  if (!access.success) return access;

  // Parse only after static access has been granted. Input-aware hooks receive parsed input.
  const inputResult = safeParseBounded(capability.input, rawInput);
  if (!inputResult.success) {
    const error = ctx.errors.validation('Invalid input', {
      capability: canonicalName,
      issues: inputResult.error.issues,
      // The first failing field, as the wire exposes it (SAFE_ERROR_METADATA_KEYS carries
      // 'field' and 'reason'): the caller marks the input and moves on instead of receiving a
      // bare 'Invalid input' it cannot map anywhere. Custom messages ride
      // along in `reason` when a check set one.
      field: zodIssueField(
        inputResult.error.issues as unknown as readonly { path: PropertyKey[] }[],
      ),
      reason: zodIssueReason(
        inputResult.error.issues as unknown as readonly { params?: { reason?: string } }[],
      ),
    });
    await recordAudit(ctx, capability, canonicalName, 'failure', { error });
    return { success: false, error };
  }

  const input = inputResult.data as z.infer<TInput>;

  // 2. Evaluate access policy (deny-by-default)
  const authResult = await authorizeCapability(capability, ctx, input);
  if (!authResult.success) return authResult;

  const approvalGate = await evaluateApprovalGate({ capability, ctx, input });
  if (approvalGate.blocked) {
    const error = ctx.errors.forbidden(approvalGate.reason, {
      capability: canonicalName,
      approvalGate: approvalGate.code,
      ...approvalGate.metadata,
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
      if (options?.beforeCommit && existingScope.db) {
        await options.beforeCommit(existingScope.db, validatedOutput);
      }
    } else if (useTransactional && withTransaction) {
      validatedOutput = await withTransaction(async (scope) => {
        const handlerCtx = buildHandlerContext(ctx, anyCap, invocationRuntime, scope);
        const output = await runHandlerWithOutputValidation(anyCap, handlerCtx, input);
        if (options?.beforeCommit && scope.db) await options.beforeCommit(scope.db, output);
        return output;
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

/**
 * The input boundary's answer to "where and why": the first issue's path as a dotted field
 * name and its rule. Keys match the safe-metadata allow-list (`field`, `reason`), so the
 * refusal reaches the caller with something a form can mark — a bare 'Invalid input' left
 * validation refusals unable to identify the affected field.
 */
function zodIssueField(
  issues: readonly { path: PropertyKey[]; params?: { reason?: string } }[],
): string | undefined {
  const first = issues[0];
  if (!first) return undefined;
  const path = first.path ?? [];
  return path.length > 0 ? path.map(String).join('.') : 'body';
}

function zodIssueReason(issues: readonly { params?: { reason?: string } }[]): string | undefined {
  const first = issues[0] as { params?: { reason?: string } } | undefined;
  const paramReason = first?.params?.reason;
  return typeof paramReason === 'string' && paramReason.length > 0 ? paramReason : undefined;
}

async function recordAudit(
  ctx: ExecutionContext,
  capability: CapabilityContract<any, any>,
  canonicalName: string,
  outcome: 'success' | 'failure' | 'denied',
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (capability.audit?.enabled === false) return;
  if (outcome === 'success' && skipsSuccessfulQueryAudit(ctx, capability)) return;

  const auditEvent = capability.audit?.event ?? `capability.${canonicalName}`;
  const stack = ctx.__runtime?.capabilityStack ?? [];
  const caller = ctx.__runtime?.invocationCaller;
  const correlationId = ctx.__runtime?.correlationId;

  try {
    await ctx.audit.record(auditEvent, {
      capability: canonicalName,
      domain: capability.domain,
      kind: capability.kind,
      actor: ctx.auth.userId,
      tenantId: ctx.auth.tenantId,
      ...(caller ? { caller } : {}),
      ...(stack.length > 0 ? { capabilityStack: stack } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...metadata,
      outcome,
    });
  } catch {
    ctx.logger.error(`Failed to record audit for capability "${canonicalName}"`);
    throw ctx.errors.internal('Audit persistence failed', { capability: canonicalName });
  }
}

/**
 * `execution.auditSuccessfulQueries: false` drops the success row of a `query` capability —
 * the bulk of audit volume for read-heavy apps — unless the capability asks for it with
 * `audit.enabled: true`. Failed and denied calls, and other kinds, are always recorded.
 */
function skipsSuccessfulQueryAudit(
  ctx: ExecutionContext,
  capability: CapabilityContract<any, any>,
): boolean {
  if (capability.kind !== CapabilityKind.Query) return false;
  if (capability.audit?.enabled === true) return false;
  const execution = (ctx.config as { execution?: { auditSuccessfulQueries?: boolean } } | undefined)
    ?.execution;
  return execution?.auditSuccessfulQueries === false;
}
