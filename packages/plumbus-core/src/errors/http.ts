import type { ErrorCode } from '../types/enums.js';
import type { PlumbusErrorLike } from '../types/errors.js';

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

export function errorToHttpResponse(error: PlumbusErrorLike): {
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
