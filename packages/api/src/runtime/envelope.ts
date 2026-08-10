import { isPlumbusError, type ApiTestMode, type PlumbusError } from '@plumbus/core';

export type ApiErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'csrf_failed'
  | 'missing_scope'
  | 'tenant_boundary_violation'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'idempotency_conflict'
  | 'test_intent_not_supported'
  | 'test_scenario_not_found'
  | 'business_rule_failed'
  | 'authentication_unavailable'
  | 'internal_error';

export interface ApiSuccessEnvelope<T = unknown> {
  ok: true;
  intent?: 'test';
  mode?: ApiTestMode;
  data: T;
  test?: {
    sideEffects: 'disabled';
    source?: string;
    scenario?: string;
    contractVersion?: string;
  };
  meta: { requestId: string; apiVersion: string };
}

export interface ApiErrorEnvelope {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: { path: string; message: string }[];
    requestId: string;
  };
  meta: { apiVersion: string };
}

const GENERIC_INTERNAL_MESSAGE = 'An internal error occurred';

const coreCodeMap: Record<string, ApiErrorCode> = {
  validation: 'validation_failed',
  notFound: 'not_found',
  forbidden: 'forbidden',
  conflict: 'conflict',
  internal: 'internal_error',
  leaseLost: 'conflict',
  cancelled: 'conflict',
};

const statusMap: Record<ApiErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  csrf_failed: 403,
  missing_scope: 403,
  tenant_boundary_violation: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  idempotency_conflict: 409,
  test_intent_not_supported: 400,
  test_scenario_not_found: 400,
  business_rule_failed: 422,
  authentication_unavailable: 503,
  internal_error: 500,
};

function getMetadataStatusCode(metadata: Record<string, unknown> | undefined): number | undefined {
  const statusCode = metadata?.httpStatus;
  if (typeof statusCode !== 'number') {
    return undefined;
  }
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    return undefined;
  }
  return statusCode;
}

function extractValidationDetails(
  metadata: Record<string, unknown> | undefined,
): { path: string; message: string }[] | undefined {
  const issues = metadata?.issues;
  if (!Array.isArray(issues)) {
    return undefined;
  }
  const details: { path: string; message: string }[] = [];
  for (const issue of issues) {
    if (
      typeof issue === 'object' &&
      issue !== null &&
      'message' in issue &&
      typeof (issue as { message: unknown }).message === 'string'
    ) {
      const pathParts = (issue as { path?: unknown }).path;
      const path =
        Array.isArray(pathParts) && pathParts.length > 0 ? pathParts.map(String).join('.') : '';
      details.push({
        path,
        message: (issue as { message: string }).message,
      });
    }
  }
  return details.length > 0 ? details : undefined;
}

export function mapApiErrorCode(code: ApiErrorCode): number {
  return statusMap[code];
}

export function mapUnauthenticated(
  requestId: string,
  apiVersion: string,
): { status: number; body: ApiErrorEnvelope } {
  return {
    status: statusMap.unauthenticated,
    body: {
      ok: false,
      error: {
        code: 'unauthenticated',
        message: 'Authentication required',
        requestId,
      },
      meta: { apiVersion },
    },
  };
}

export function mapCsrfFailed(
  requestId: string,
  apiVersion: string,
): { status: number; body: ApiErrorEnvelope } {
  return {
    status: statusMap.csrf_failed,
    body: {
      ok: false,
      error: {
        code: 'csrf_failed',
        message: 'CSRF validation failed',
        requestId,
      },
      meta: { apiVersion },
    },
  };
}

export function mapAuthenticationUnavailable(
  requestId: string,
  apiVersion: string,
): { status: number; body: ApiErrorEnvelope } {
  return {
    status: statusMap.authentication_unavailable,
    body: {
      ok: false,
      error: {
        code: 'authentication_unavailable',
        message: 'Authentication temporarily unavailable',
        requestId,
      },
      meta: { apiVersion },
    },
  };
}

export function mapMissingScope(
  missing: string[],
  requestId: string,
  apiVersion: string,
): { status: number; body: ApiErrorEnvelope } {
  return {
    status: statusMap.missing_scope,
    body: {
      ok: false,
      error: {
        code: 'missing_scope',
        message: `Missing scopes: ${missing.join(', ')}`,
        requestId,
      },
      meta: { apiVersion },
    },
  };
}

export function mapTenantBoundaryViolation(
  params: string[],
  requestId: string,
  apiVersion: string,
): { status: number; body: ApiErrorEnvelope } {
  return {
    status: statusMap.tenant_boundary_violation,
    body: {
      ok: false,
      error: {
        code: 'tenant_boundary_violation',
        message: `Explicit tenant parameters are not allowed: ${params.join(', ')}`,
        requestId,
      },
      meta: { apiVersion },
    },
  };
}

export function mapCoreError(
  err: PlumbusError | { code: string; message: string; metadata?: Record<string, unknown> },
  requestId: string,
  apiVersion: string,
): { status: number; body: ApiErrorEnvelope } {
  const mapped = coreCodeMap[err.code] ?? 'internal_error';
  const metadata = 'metadata' in err ? err.metadata : undefined;
  const metadataStatus = getMetadataStatusCode(metadata);
  const message = mapped === 'internal_error' ? GENERIC_INTERNAL_MESSAGE : err.message;
  const details = mapped === 'validation_failed' ? extractValidationDetails(metadata) : undefined;

  return {
    status: metadataStatus ?? statusMap[mapped],
    body: {
      ok: false,
      error: {
        code: mapped,
        message,
        ...(details ? { details } : {}),
        requestId,
      },
      meta: { apiVersion },
    },
  };
}

export function mapUnknownError(
  requestId: string,
  apiVersion: string,
): { status: number; body: ApiErrorEnvelope } {
  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: 'internal_error',
        message: GENERIC_INTERNAL_MESSAGE,
        requestId,
      },
      meta: { apiVersion },
    },
  };
}

export function toPlumbusErrorLike(err: unknown): PlumbusError | null {
  if (isPlumbusError(err)) {
    return err;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return err as PlumbusError;
  }
  return null;
}

export function buildSuccessEnvelope<T>(
  data: T,
  requestId: string,
  apiVersion: string,
): ApiSuccessEnvelope<T> {
  return {
    ok: true,
    data,
    meta: { requestId, apiVersion },
  };
}
