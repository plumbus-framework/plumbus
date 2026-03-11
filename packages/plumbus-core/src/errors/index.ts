import { ErrorCode } from '../types/enums.js';
import type { ErrorService, PlumbusError } from '../types/errors.js';

function createError(
  code: ErrorCode,
  message: string,
  metadata?: Record<string, unknown>,
): PlumbusError {
  return { code, message, metadata };
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

export function isPlumbusError(value: unknown): value is PlumbusError {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['code'] === 'string' &&
    typeof obj['message'] === 'string' &&
    Object.values(ErrorCode).includes(obj['code'] as ErrorCode)
  );
}
