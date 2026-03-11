import type { ErrorCode } from '../types/enums.js';
import type { PlumbusError } from '../types/errors.js';

/**
 * Map PlumbusError codes to HTTP status codes.
 */
const statusMap: Record<ErrorCode, number> = {
  validation: 400,
  notFound: 404,
  forbidden: 403,
  conflict: 409,
  internal: 500,
};

export function errorToHttpStatus(error: PlumbusError): number {
  return statusMap[error.code] ?? 500;
}

export function errorToHttpResponse(error: PlumbusError): {
  statusCode: number;
  body: { error: { code: string; message: string; metadata?: Record<string, unknown> } };
} {
  return {
    statusCode: errorToHttpStatus(error),
    body: {
      error: {
        code: error.code,
        message: error.message,
        metadata: error.metadata,
      },
    },
  };
}
