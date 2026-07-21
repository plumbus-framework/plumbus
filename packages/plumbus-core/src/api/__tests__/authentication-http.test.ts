import { describe, expect, it } from 'vitest';
import { authenticationFailureToHttp, buildAuthenticationRequest } from '../authentication-http.js';

describe('authenticationFailureToHttp', () => {
  it('maps invalid_authorization to 401 with www-authenticate', () => {
    const result = authenticationFailureToHttp({
      status: 'invalid',
      code: 'invalid_authorization',
    });
    expect(result.statusCode).toBe(401);
    expect(result.headers).toEqual({ 'www-authenticate': 'Bearer error="invalid_token"' });
    expect(result.body.error.code).toBe('unauthorized');
    expect(result.body.error.message).toBe('Authentication required');
  });

  it('maps csrf_failed to 403', () => {
    const result = authenticationFailureToHttp({ status: 'invalid', code: 'csrf_failed' });
    expect(result.statusCode).toBe(403);
    expect(result.body.error.code).toBe('csrf_failed');
    expect(result.body.error.message).toBe('CSRF validation failed');
  });

  it('maps unavailable to 503', () => {
    const result = authenticationFailureToHttp({
      status: 'unavailable',
      code: 'authentication_unavailable',
    });
    expect(result.statusCode).toBe(503);
    expect(result.body.error.code).toBe('authentication_unavailable');
  });

  it('passes requestId through', () => {
    const result = authenticationFailureToHttp(
      { status: 'invalid', code: 'invalid_authorization' },
      'req-123',
    );
    expect(result.body.error.requestId).toBe('req-123');
  });
});

describe('buildAuthenticationRequest', () => {
  it('extracts authorization, cookies, method, path, origin, and csrf token', () => {
    const request = buildAuthenticationRequest({
      headers: {
        authorization: 'Bearer abc',
        cookie: 'session=1',
        origin: 'https://app.example.com',
        'x-csrf-token': 'csrf-1',
      },
      method: 'POST',
      url: '/api/users/get-user?limit=1',
    } as any);

    expect(request).toEqual({
      authorization: 'Bearer abc',
      cookies: { session: '1' },
      method: 'POST',
      path: '/api/users/get-user',
      origin: 'https://app.example.com',
      csrfToken: 'csrf-1',
    });
  });

  it('uses first csrf header when array is provided', () => {
    const request = buildAuthenticationRequest({
      headers: { 'x-csrf-token': ['first', 'second'] },
      method: 'POST',
      url: '/',
    } as any);
    expect(request.csrfToken).toBe('first');
  });
});
