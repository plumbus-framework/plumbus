import { describe, expect, it } from 'vitest';
import { mapCoreError } from '../envelope.js';

describe('mapCoreError', () => {
  it('uses generic message for internal errors', () => {
    const { body } = mapCoreError(
      { code: 'internal', message: 'database connection leaked secret' },
      'req_1',
      'v1',
    );
    expect(body.error.message).toBe('An internal error occurred');
    expect(body.error.code).toBe('internal_error');
  });

  it('maps leaseLost to conflict', () => {
    const { status, body } = mapCoreError(
      { code: 'leaseLost', message: 'lease expired' },
      'req_1',
      'v1',
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
  });

  it('populates validation details from issues metadata', () => {
    const { body } = mapCoreError(
      {
        code: 'validation',
        message: 'Invalid input',
        metadata: {
          issues: [{ path: ['email'], message: 'Invalid email' }],
        },
      },
      'req_1',
      'v1',
    );
    expect(body.error.details).toEqual([{ path: 'email', message: 'Invalid email' }]);
  });

  it('honors metadata.httpStatus override', () => {
    const { status } = mapCoreError(
      { code: 'forbidden', message: 'nope', metadata: { httpStatus: 418 } },
      'req_1',
      'v1',
    );
    expect(status).toBe(418);
  });
});
