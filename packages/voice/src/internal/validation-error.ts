import { ErrorCode, PlumbusError } from '@plumbus/core';

export function throwDefineValidationError(
  message: string,
  metadata?: Record<string, unknown>,
): never {
  throw new PlumbusError(ErrorCode.Validation, message, {
    reason: 'define_validation',
    ...metadata,
  });
}
