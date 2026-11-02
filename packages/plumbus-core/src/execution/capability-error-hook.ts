// ── Capability Error Hook ──
// Payload and fire-and-forget dispatch for `onCapabilityError`, shared by
// HTTP routes and the worker (flow steps, jobs, event handlers).

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { CapabilityContract } from '../types/capability.js';
import type { ExecutionContext } from '../types/context.js';
import { getCanonicalCapabilityName } from './canonical-name.js';
import { logHookError } from '../errors/hook-log.js';
import {
  exposeOriginalError,
  getOriginalError,
  getErrorExecutionDetails,
  type ErrorExecutionDetails,
} from '../observability/index.js';

/** Passed to `onCapabilityError` when a capability returns a non-success result. */
export interface CapabilityErrorInfo {
  capabilityName: string;
  domain: string;
  errorCode: string;
  errorMessage: string;
  /** Original thrown value, in memory only. Non-enumerable; reporters must sanitize it. */
  originalError?: unknown;
  /** Execution coordinates only; no inputs, auth snapshots or credentials. Non-enumerable. */
  diagnostics?: ErrorExecutionDetails;
  metadata?: Record<string, unknown>;
  userId?: string;
  tenantId?: string;
  /** Client IP — HTTP only. */
  sourceIp?: string;
  /** HTTP User-Agent — HTTP only. */
  userAgent?: string;
  db?: PostgresJsDatabase;
  /** Where the capability ran: an HTTP route, a flow step, a job, or an event handler. */
  source?: 'http' | 'flow' | 'job' | 'event';
}

export function capabilityExecutionDetails(
  capability: Pick<CapabilityContract, 'name' | 'domain'> &
    Partial<Pick<CapabilityContract, 'version' | 'kind'>>,
  ctx: ExecutionContext,
): ErrorExecutionDetails {
  const name = getCanonicalCapabilityName(capability);
  const stack = [...(ctx.__runtime?.capabilityStack ?? [])];
  if (stack.at(-1) !== name) stack.push(name);
  return {
    actorUserId: ctx.auth?.userId,
    tenantId: ctx.auth?.tenantId,
    correlationId: ctx.__runtime?.correlationId,
    capabilityStack: Object.freeze(stack),
    capabilityVersion: capability.kind ? (capability.version ?? '1') : undefined,
    capabilityKind: capability.kind,
    flowId: ctx.flowId,
    step: ctx.step,
    workerId: ctx.workerId,
  };
}

/**
 * Call the hook without awaiting it. Sync throws and rejections are logged,
 * never rethrown, so the hook cannot change the response or worker outcome.
 */
export function fireCapabilityErrorHook(
  hook: ((info: CapabilityErrorInfo) => void | Promise<void>) | undefined,
  info: CapabilityErrorInfo,
  failure?: unknown,
  details?: ErrorExecutionDetails,
): void {
  if (!hook) return;
  const captured = getErrorExecutionDetails(failure, details);
  exposeOriginalError(
    info,
    getOriginalError(failure),
    captured || details ? { ...details, ...captured } : undefined,
  );
  // IIFE so a sync throw inside the hook is caught by .catch.
  void (async () => hook(info))().catch((hookErr) => {
    logHookError('onCapabilityError', hookErr);
  });
}
