// Private, in-memory provenance: never add raw errors to metadata or persistent records.
const OriginalError = Symbol('plumbus.original-error');
const ExecutionDetails = Symbol('plumbus.error-execution-details');

export interface ErrorExecutionDetails {
  readonly actorUserId?: string;
  readonly tenantId?: string;
  readonly correlationId?: string;
  readonly capabilityStack?: readonly string[];
  readonly capabilityVersion?: string;
  readonly capabilityKind?: string;
  readonly flowId?: string;
  readonly step?: string;
  readonly jobId?: string;
  readonly eventId?: string;
  readonly initiatingActor?: string;
  readonly flowDefinitionVersion?: string;
  readonly flowDefinitionDigest?: string;
  readonly httpMethod?: string;
  readonly httpRoute?: string;
  readonly httpStatus?: number;
  readonly workerId?: string;
}

export function preserveOriginalError<T extends object>(
  target: T,
  originalError: unknown,
  details?: ErrorExecutionDetails,
): T {
  try {
    // Do not overwrite the deeper exception when a nested invocation propagates its failure.
    if (Object.hasOwn(target, OriginalError)) return target;
    Object.defineProperty(target, OriginalError, { value: originalError });
    const context = getErrorExecutionDetails(originalError, details) ?? details;
    if (context)
      Object.defineProperty(target, ExecutionDetails, {
        value: Object.freeze({
          ...context,
          ...(context.capabilityStack
            ? { capabilityStack: Object.freeze([...context.capabilityStack]) }
            : {}),
        }),
      });
  } catch {
    // A custom error service may return frozen objects. Diagnostics must not change the outcome.
  }
  return target;
}

export function getErrorExecutionDetails(
  target: unknown,
  current?: ErrorExecutionDetails,
): ErrorExecutionDetails | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  try {
    const captured = (target as { [ExecutionDetails]?: ErrorExecutionDetails })[ExecutionDetails];
    // Applications sometimes reuse exception instances. Never borrow another caller's coordinates.
    if (
      captured &&
      current &&
      (captured.actorUserId !== current.actorUserId ||
        captured.tenantId !== current.tenantId ||
        (captured.correlationId &&
          current.correlationId &&
          captured.correlationId !== current.correlationId) ||
        (captured.flowId && current.flowId && captured.flowId !== current.flowId))
    )
      return current;
    return captured;
  } catch {
    return undefined;
  }
}

export function getOriginalError(target: unknown): unknown {
  if (typeof target !== 'object' || target === null) return undefined;
  try {
    return (target as { [OriginalError]?: unknown })[OriginalError];
  } catch {
    return undefined;
  }
}

/** Explicit access works; existing spread/JSON loggers do not gain a raw exception payload. */
export function exposeOriginalError<T extends object>(
  info: T,
  originalError: unknown,
  details?: ErrorExecutionDetails,
): T {
  try {
    if (originalError !== undefined)
      Object.defineProperty(info, 'originalError', { value: originalError });
    if (details)
      Object.defineProperty(info, 'diagnostics', {
        value: Object.freeze({
          ...details,
          ...(details.capabilityStack
            ? { capabilityStack: Object.freeze([...details.capabilityStack]) }
            : {}),
        }),
      });
  } catch {
    /* A custom frozen hook payload must not alter execution. */
  }
  return info;
}
