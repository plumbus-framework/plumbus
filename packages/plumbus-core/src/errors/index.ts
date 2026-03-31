import { ErrorCode } from '../types/enums.js';
import type { ErrorService } from '../types/errors.js';

// ── PlumbusError Class ──
// Extends Error for proper stack traces and instanceof support.
// toJSON() ensures safe serialization (Error.message is non-enumerable).
export class PlumbusError extends Error {
  readonly code: ErrorCode;
  readonly metadata?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, metadata?: Record<string, unknown>) {
    super(message);
    this.name = 'PlumbusError';
    this.code = code;
    this.metadata = metadata;
  }

  toJSON(): { code: ErrorCode; message: string; metadata?: Record<string, unknown> } {
    return { code: this.code, message: this.message, metadata: this.metadata };
  }
}

function createError(
  code: ErrorCode,
  message: string,
  metadata?: Record<string, unknown>,
): PlumbusError {
  return new PlumbusError(code, message, metadata);
}

export function createErrorService(): ErrorService {
  return {
    validation: (message, metadata) => createError(ErrorCode.Validation, message, metadata),
    notFound: (message, metadata) => createError(ErrorCode.NotFound, message, metadata),
    forbidden: (message, metadata) => createError(ErrorCode.Forbidden, message, metadata),
    conflict: (message, metadata) => createError(ErrorCode.Conflict, message, metadata),
    internal: (message, metadata) => createError(ErrorCode.Internal, message, metadata),
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
