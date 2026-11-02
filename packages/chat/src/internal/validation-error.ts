import { PlumbusError, ErrorCode } from '@plumbus/core/sdk';

export function throwDefineValidationError(
  message: string,
  metadata?: Record<string, unknown>,
): never {
  throw new PlumbusError(ErrorCode.Validation, message, {
    reason: 'define_validation',
    ...metadata,
  });
}
