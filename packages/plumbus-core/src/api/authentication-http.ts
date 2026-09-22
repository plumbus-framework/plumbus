import type { FastifyRequest } from 'fastify';
import type { AuthenticationRequest, AuthenticationResult } from '../auth/http-authentication.js';
import { parseCookieHeader } from './cookies.js';

export function buildAuthenticationRequest(request: FastifyRequest): AuthenticationRequest {
  const csrfHeader = request.headers['x-csrf-token'];
  const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;

  return {
    authorization: request.headers.authorization,
    cookies: parseCookieHeader(request.headers.cookie),
    method: request.method,
    path: request.url.split('?')[0] ?? request.url,
    origin: request.headers.origin,
    csrfToken,
  };
}

export function authenticationFailureToHttp(
  result: Extract<AuthenticationResult, { status: 'invalid' | 'unavailable' }>,
  requestId?: string,
): {
  statusCode: number;
  headers?: Record<string, string>;
  body: { error: { code: string; message: string; requestId?: string } };
} {
  if (result.status === 'invalid' && result.code === 'csrf_failed') {
    return {
      statusCode: 403,
      body: {
        error: {
          code: 'csrf_failed',
          message: 'CSRF validation failed',
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }

  if (result.status === 'unavailable') {
    return {
      statusCode: 503,
      body: {
        error: {
          code: 'authentication_unavailable',
          message: 'Authentication temporarily unavailable',
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }

  return {
    statusCode: 401,
    headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
    body: {
      error: {
        code: 'unauthorized',
        message: 'Authentication required',
        ...(requestId ? { requestId } : {}),
      },
    },
  };
}
