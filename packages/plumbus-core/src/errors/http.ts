import type { ErrorCode } from '../types/enums.js';
import type { PlumbusErrorLike } from '../types/errors.js';
import { pickSafeMetadata } from './safe-metadata.js';

/**
 * Map PlumbusError codes to HTTP status codes.
 */
const statusMap: Record<ErrorCode, number> = {
  validation: 400,
  notFound: 404,
  forbidden: 403,
  conflict: 409,
  internal: 500,
  leaseLost: 409,
  cancelled: 499, // Client Closed Request (nginx convention) — operation cancelled by caller
  dependencyViolation: 400,
  unauthorized: 401,
};

function getMetadataStatusCode(error: PlumbusErrorLike): number | undefined {
  const statusCode = error.metadata?.httpStatus;
  if (typeof statusCode !== 'number') return undefined;
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) return undefined;
  return statusCode;
}

export function errorToHttpStatus(error: PlumbusErrorLike): number {
  const metadataStatusCode = getMetadataStatusCode(error);
  if (metadataStatusCode != null) {
    return metadataStatusCode;
  }
  return statusMap[error.code] ?? 500;
}

export const GENERIC_INTERNAL_MESSAGE = 'An internal error occurred';

export function errorToHttpResponse(error: PlumbusErrorLike): {
  statusCode: number;
  body: { error: { code: string; message: string; metadata?: Record<string, unknown> } };
} {
  const safeMetadata = pickSafeMetadata(error.metadata);
  const message = error.code === 'internal' ? GENERIC_INTERNAL_MESSAGE : error.message;

  return {
    statusCode: errorToHttpStatus(error),
    body: {
      error: {
        code: error.code,
        message,
        metadata: safeMetadata,
      },
    },
  };
}

/** Shape a safe SSE error payload (M5). */
export function errorToSsePayload(error: PlumbusErrorLike): {
  type: 'error';
  error: { code: string; message: string; metadata?: Record<string, unknown> };
} {
  const http = errorToHttpResponse(error);
  return {
    type: 'error',
    error: http.body.error,
  };
}

/** Build a safe SSE error event from an unknown thrown value. */
export function unknownErrorToSsePayload(err: unknown): {
  type: 'error';
  error: { code: string; message: string; metadata?: Record<string, unknown> };
} {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    typeof (err as PlumbusErrorLike).code === 'string' &&
    typeof (err as PlumbusErrorLike).message === 'string'
  ) {
    return errorToSsePayload(err as PlumbusErrorLike);
  }

  return {
    type: 'error',
    error: {
      code: 'internal',
      message: GENERIC_INTERNAL_MESSAGE,
    },
  };
}
