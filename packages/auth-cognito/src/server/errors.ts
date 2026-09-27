/** Why a Cognito server operation failed. Operational codes, safe to log and to map to responses. */
export const CognitoServerErrorReason = {
  /** The user does not exist in the pool. */
  userNotFound: 'user-not-found',
  /** The user exists but is disabled in the pool. */
  userDisabled: 'user-disabled',
  /** Cognito refused the custom-auth exchange (no tokens issued). */
  challengeRefused: 'challenge-refused',
  /** Tokens came back but failed issuer, audience, signature or claim checks. */
  tokenInvalid: 'token-invalid',
  /** The user pool does not exist (or is not visible to these credentials). */
  poolNotFound: 'pool-not-found',
  /** A pool with the expected name exists but is not owned by the caller, or several match. */
  poolConflict: 'pool-conflict',
  /** A pool trigger failed or returned an invalid response. */
  triggerFailed: 'trigger-failed',
  /** Network failure, timeout, throttling or a Cognito server fault. Retryable. */
  providerUnavailable: 'provider-unavailable',
  /** Any other refusal by Cognito (validation, permissions, configuration). */
  requestRefused: 'request-refused',
} as const;

export type CognitoServerErrorReason =
  (typeof CognitoServerErrorReason)[keyof typeof CognitoServerErrorReason];

/** The one error type `@plumbus/auth-cognito/server` throws. `reason` is the stable part. */
export class CognitoServerError extends Error {
  readonly reason: CognitoServerErrorReason;
  /** The Cognito exception name when there was one, e.g. `NotAuthorizedException`. */
  readonly cognitoError?: string;

  constructor(
    reason: CognitoServerErrorReason,
    message: string,
    options: { cause?: unknown; cognitoError?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CognitoServerError';
    this.reason = reason;
    if (options.cognitoError) this.cognitoError = options.cognitoError;
  }
}

const UNAVAILABLE_NAMES = new Set([
  'InternalErrorException',
  'TooManyRequestsException',
  'TooManyFailedAttemptsException',
  'LimitExceededException',
  'ThrottlingException',
  'TimeoutError',
  'RequestTimeout',
  'AbortError',
]);

const TRIGGER_NAMES = new Set([
  'InvalidLambdaResponseException',
  'UnexpectedLambdaException',
  'UserLambdaValidationException',
]);

interface SdkErrorShape {
  name?: unknown;
  message?: unknown;
  $fault?: unknown;
  $metadata?: { httpStatusCode?: number };
}

/** Maps anything the AWS SDK throws to a `CognitoServerError` with a stable reason. */
export function toCognitoServerError(error: unknown): CognitoServerError {
  if (error instanceof CognitoServerError) return error;
  const shape = (typeof error === 'object' && error !== null ? error : {}) as SdkErrorShape;
  const name = typeof shape.name === 'string' ? shape.name : 'Error';
  const message = typeof shape.message === 'string' ? shape.message : 'Cognito request failed';
  const status = shape.$metadata?.httpStatusCode;
  const options = { cause: error, cognitoError: name };

  if (name === 'UserNotFoundException') {
    return new CognitoServerError(CognitoServerErrorReason.userNotFound, message, options);
  }
  if (name === 'NotAuthorizedException') {
    const disabled = /user is disabled/i.test(message);
    return new CognitoServerError(
      disabled ? CognitoServerErrorReason.userDisabled : CognitoServerErrorReason.challengeRefused,
      message,
      options,
    );
  }
  if (name === 'ResourceNotFoundException') {
    return new CognitoServerError(CognitoServerErrorReason.poolNotFound, message, options);
  }
  if (TRIGGER_NAMES.has(name)) {
    return new CognitoServerError(CognitoServerErrorReason.triggerFailed, message, options);
  }
  // No HTTP status at all means the request never got an answer: a network or timeout failure.
  if (
    UNAVAILABLE_NAMES.has(name) ||
    shape.$fault === 'server' ||
    (typeof status === 'number' && status >= 500) ||
    status === undefined
  ) {
    return new CognitoServerError(CognitoServerErrorReason.providerUnavailable, message, options);
  }
  return new CognitoServerError(CognitoServerErrorReason.requestRefused, message, options);
}
