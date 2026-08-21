import { ErrorCode } from '../types/enums.js';
import { PlumbusError } from './plumbus-error.js';

export class DataValidationError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Validation, message, metadata);
    this.name = 'DataValidationError';
  }
}

export class DataForbiddenError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Forbidden, message, metadata);
    this.name = 'DataForbiddenError';
  }
}

export class DataInternalError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Internal, message, metadata);
    this.name = 'DataInternalError';
  }
}

export class EncryptionConfigError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Validation, message, metadata);
    this.name = 'EncryptionConfigError';
  }
}

export class EncryptionPayloadError extends PlumbusError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Validation, message, metadata);
    this.name = 'EncryptionPayloadError';
  }
}

export class AISecurityBlockedError extends PlumbusError {
  constructor(fields: string[], metadata?: Record<string, unknown>) {
    super(
      ErrorCode.Forbidden,
      `AI security block: classified fields in prompt input (${fields.join(', ')})`,
      { fields, ...metadata },
    );
    this.name = 'AISecurityBlockedError';
  }
}

export class AIBudgetExceededError extends PlumbusError {
  constructor(reason: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Forbidden, `AI budget exceeded: ${reason}`, { reason, ...metadata });
    this.name = 'AIBudgetExceededError';
  }
}

export type GovernedAiBlockedCode =
  | 'unpinned-prompt'
  | 'unpinned-policy'
  | 'artifact-kind-mismatch'
  | 'unregistered-model'
  | 'model-pin-mismatch'
  | 'missing-review'
  | 'expired-review'
  | 'budget-unknown'
  | 'budget-exceeded';

/** Fail-closed stop before a governed model call. The model is not invoked. */
export class GovernedAiBlockedError extends PlumbusError {
  readonly blockedCode: GovernedAiBlockedCode;

  constructor(code: GovernedAiBlockedCode, message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.Forbidden, message, { code, ...metadata });
    this.name = 'GovernedAiBlockedError';
    this.blockedCode = code;
  }
}
