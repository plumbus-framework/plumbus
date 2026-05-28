import { PlumbusError } from '../errors/index.js';
import { ErrorCode } from '../types/enums.js';

export function throwDefineValidationError(
  message: string,
  metadata?: Record<string, unknown>,
): never {
  throw new PlumbusError(ErrorCode.Validation, message, {
    reason: 'define_validation',
    ...metadata,
  });
}
