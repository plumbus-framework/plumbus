import { describe, expect, it } from 'vitest';
import { errorToHttpStatus } from '../http.js';
import { createErrorService, isPlumbusError, PlumbusError, UnauthorizedError } from '../index.js';

describe('ErrorService', () => {
  const errors = createErrorService();

  it('creates a validation error', () => {
    const err = errors.validation('invalid email');
    expect(err.code).toBe('validation');
    expect(err.message).toBe('invalid email');
  });

  it('creates a notFound error', () => {
    const err = errors.notFound('user not found');
    expect(err.code).toBe('notFound');
  });

  it('creates a forbidden error', () => {
    const err = errors.forbidden('access denied');
    expect(err.code).toBe('forbidden');
  });

  it('creates a conflict error', () => {
    const err = errors.conflict('duplicate email');
    expect(err.code).toBe('conflict');
  });

  it('creates an internal error', () => {
    const err = errors.internal('unexpected failure');
    expect(err.code).toBe('internal');
  });

  it('attaches metadata', () => {
    const err = errors.validation('bad', { field: 'email' });
    expect(err.metadata).toEqual({ field: 'email' });
  });

  it('returns PlumbusError class instances', () => {
    const err = errors.validation('test');
    expect(err).toBeInstanceOf(PlumbusError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has a stack trace', () => {
    const err = errors.internal('boom') as PlumbusError;
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('boom');
  });

  it('serializes correctly via toJSON', () => {
    const err = errors.validation('bad email', { field: 'email' });
    const json = JSON.parse(JSON.stringify(err));
    expect(json).toEqual({
      code: 'validation',
      message: 'bad email',
      metadata: { field: 'email' },
    });
  });

  it('sets name to PlumbusError', () => {
    const err = errors.notFound('missing') as PlumbusError;
    expect(err.name).toBe('PlumbusError');
  });
});

describe('isPlumbusError', () => {
  const errors = createErrorService();

  it('returns true for PlumbusError class instances', () => {
    expect(isPlumbusError(errors.validation('x'))).toBe(true);
  });

  it('returns true for plain objects with valid code and message (backward compat)', () => {
    expect(isPlumbusError({ code: 'validation', message: 'x' })).toBe(true);
    expect(isPlumbusError({ code: 'notFound', message: 'y' })).toBe(true);
    expect(isPlumbusError({ code: 'forbidden', message: 'z' })).toBe(true);
  });

  it('returns false for random objects', () => {
    expect(isPlumbusError({ code: 'unknown', message: 'x' })).toBe(false);
    expect(isPlumbusError(null)).toBe(false);
    expect(isPlumbusError('string')).toBe(false);
  });
});

describe('UnauthorizedError', () => {
  it('maps to unauthorized code and 401 status', () => {
    const err = new UnauthorizedError('Authentication required');
    expect(err.code).toBe('unauthorized');
    expect(err.name).toBe('UnauthorizedError');
    expect(errorToHttpStatus(err)).toBe(401);
    expect(isPlumbusError(err)).toBe(true);
  });
});
