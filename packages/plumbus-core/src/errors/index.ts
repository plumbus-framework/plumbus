import { ErrorCode } from '../types/enums.js';
import type { ErrorService } from '../types/errors.js';
import { PlumbusError } from './plumbus-error.js';

export { PlumbusError } from './plumbus-error.js';
export {
  AISecurityBlockedError,
  AIBudgetExceededError,
  GovernedAiBlockedError,
  type GovernedAiBlockedCode,
  DataForbiddenError,
  DataInternalError,
  DataValidationError,
  EncryptionConfigError,
  EncryptionPayloadError,
} from './data-errors.js';

function createError(
  code: ErrorCode,
  message: string,
  metadata?: Record<string, unknown>,
): PlumbusError {
  return new PlumbusError(code, message, metadata);
}

export class LeaseLostError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.LeaseLost, message, metadata);
    this.name = 'LeaseLostError';
  }
}

/**
 * Raised as the AbortSignal reason when a flow step is cancelled via
 * `flows.cancel()`. Surfaced to capability handlers that await cancelable
 * HTTP/AI calls (the DOM `fetch` maps abort to a `DOMException('AbortError')`
 * — the reason is available via `signal.reason`).
 */
export class BudgetExhaustedError extends PlumbusError {
  constructor(executionId: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Forbidden, `Execution budget exhausted for "${executionId}"`, {
      executionId,
      reason: 'budget-exhausted',
      ...metadata,
    });
    this.name = 'BudgetExhaustedError';
  }
}

export class FlowCancelledError extends PlumbusError {
  constructor(executionId: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Cancelled, `Flow execution "${executionId}" was cancelled`, {
      executionId,
      ...metadata,
    });
    this.name = 'FlowCancelledError';
  }
}

export class UnauthorizedError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Unauthorized, message, metadata);
    this.name = 'UnauthorizedError';
  }
}

export function createErrorService(): ErrorService {
  return {
    validation: (message, metadata) => createError(ErrorCode.Validation, message, metadata),
    notFound: (message, metadata) => createError(ErrorCode.NotFound, message, metadata),
    forbidden: (message, metadata) => createError(ErrorCode.Forbidden, message, metadata),
    conflict: (message, metadata) => createError(ErrorCode.Conflict, message, metadata),
    internal: (message, metadata) => createError(ErrorCode.Internal, message, metadata),
    dependencyViolation: (message, metadata) =>
      createError(ErrorCode.DependencyViolation, message, metadata),
  };
}

// Duck-type check with instanceof fast-path.
// Accepts both PlumbusError class instances and plain objects with {code, message}
// for backward compatibility with test mocks and manual construction.
export function isPlumbusError(value: unknown): value is PlumbusError {
  if (value instanceof PlumbusError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.code === 'string' &&
    typeof obj.message === 'string' &&
    Object.values(ErrorCode).includes(obj.code as ErrorCode)
  );
}
